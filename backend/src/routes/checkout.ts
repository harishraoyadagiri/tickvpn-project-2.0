import express, { Router } from "express";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { requireAuth, AuthedRequest } from "../lib/auth";
import { asyncRoute, badRequest, notFound, HttpError } from "../lib/errors";
import { env } from "../lib/env";
import { applyWalletTransaction } from "../services/walletService";

const stripe = new Stripe(env.STRIPE_SECRET_KEY || "sk_test_placeholder", {
  apiVersion: "2024-06-20",
});

export function checkoutRouter(prisma: PrismaClient) {
  const router = Router();
  const auth = requireAuth(prisma);

  router.post(
    "/checkout",
    auth,
    asyncRoute(async (req: AuthedRequest, res) => {
      if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, "payments_not_configured");

      const productId = String(req.body?.productId ?? "");
      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product || !product.active) throw notFound("product_not_found");

      const purchase = await prisma.purchase.create({
        data: { userId: req.userId as string, productId, amountCents: product.priceCents, status: "PENDING" },
      });

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: product.currency,
              product_data: { name: product.name },
              unit_amount: product.priceCents,
            },
            quantity: 1,
          },
        ],
        // Return to the page they left, carrying the purchase id so the UI can
        // poll GET /purchases/:id rather than guessing from the balance.
        //
        // The old cancel_url pointed at /pricing, which is not a route this app
        // has — backing out of a payment landed on a 404.
        success_url: `${env.APP_URL}/dashboard/billing?purchase=success&id=${purchase.id}`,
        cancel_url: `${env.APP_URL}/dashboard/billing?purchase=cancelled`,
        client_reference_id: purchase.id,
        metadata: { purchaseId: purchase.id, userId: req.userId as string, productId },
      });

      await prisma.purchase.update({ where: { id: purchase.id }, data: { stripeSessionId: session.id } });

      // This response only hands the client a URL. It credits nothing —
      // entitlement comes from the verified webhook and nowhere else (PRD §6).
      return res.json({ url: session.url });
    })
  );

  return router;
}

/**
 * Mounted before express.json(): Stripe signature verification needs the raw,
 * unparsed body.
 *
 * Order of operations is D4's, exactly:
 *   1. verify the signature — invalid means 400 and stop
 *   2. INSERT the event id, ON CONFLICT DO NOTHING
 *   3. zero rows inserted means already handled — 200 immediately
 *   4. otherwise process in one transaction and stamp processedAt
 *   5. return 200 fast; any non-2xx makes Stripe retry, which we only want
 *      on a genuine failure
 */
export function webhookRouter(prisma: PrismaClient) {
  const router = Router();

  router.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json" }),
    asyncRoute(async (req, res) => {
      if (!env.STRIPE_WEBHOOK_SECRET) {
        console.error("[stripe] webhook received but STRIPE_WEBHOOK_SECRET is not set");
        return res.status(503).json({ error: "payments_not_configured" });
      }

      const signature = req.headers["stripe-signature"] as string | undefined;
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(req.body, signature ?? "", env.STRIPE_WEBHOOK_SECRET);
      } catch (err: any) {
        console.error("[stripe] signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      // Step 2 + 3: the insert is the idempotency gate.
      const inserted = await prisma.stripeEvent.createMany({
        data: [{ id: event.id, type: event.type }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        console.log(`[stripe] ${event.id} already handled — no action`);
        return res.status(200).json({ received: true, duplicate: true });
      }

      try {
        switch (event.type) {
          case "checkout.session.completed":
            await handleCheckoutCompleted(prisma, event);
            break;
          case "charge.refunded":
            await handleRefund(prisma, event);
            break;
          case "charge.dispute.created":
            await handleDispute(prisma, event);
            break;
          default:
            break; // acknowledged and recorded, nothing to do
        }
      } catch (err) {
        // Leave processedAt null so the row shows an event we failed to handle,
        // and return 500 so Stripe retries. The event row still exists, so the
        // retry is gated by the wallet's idempotency key rather than this insert.
        console.error(`[stripe] failed to process ${event.id}:`, err);
        await prisma.stripeEvent.delete({ where: { id: event.id } }).catch(() => {});
        throw err;
      }

      await prisma.stripeEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
      return res.status(200).json({ received: true });
    })
  );

  return router;
}

async function handleCheckoutCompleted(prisma: PrismaClient, event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  const { purchaseId, userId, productId } = (session.metadata ?? {}) as Record<string, string>;

  if (!purchaseId || !userId || !productId) {
    console.error("[stripe] session missing metadata:", session.id);
    return;
  }

  // D4: require payment_status === 'paid'. A completed session is not a paid
  // one — delayed-settlement methods complete first and can still fail.
  if (session.payment_status !== "paid") {
    console.warn(`[stripe] session ${session.id} completed with payment_status=${session.payment_status}; not crediting`);
    await prisma.purchase.update({
      where: { id: purchaseId },
      data: { status: "PENDING", stripePaymentIntentId: (session.payment_intent as string) ?? null },
    });
    return;
  }

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    console.error("[stripe] unknown product on session", session.id);
    return;
  }

  const minutes = product.durationMinutes ?? 0;
  if (minutes <= 0) {
    console.error(`[stripe] product ${product.id} grants no minutes; not crediting`);
    return;
  }

  await applyWalletTransaction(prisma, {
    userId,
    type: "PURCHASE",
    amount: minutes,
    unit: "MINUTE",
    referenceType: "purchase",
    referenceId: purchaseId,
    idempotencyKey: `stripe:${event.id}`,
    metadata: { stripeSessionId: session.id, productName: product.name },
  });

  await prisma.purchase.update({
    where: { id: purchaseId },
    data: { status: "PAID", stripePaymentIntentId: (session.payment_intent as string) ?? null },
  });
}

/**
 * D4: refunds write a REFUND row. If the customer already spent the minutes we
 * do NOT force the wallet negative — clamp at zero and leave the ledger to
 * record the truth. The gap becomes an admin case.
 */
async function handleRefund(prisma: PrismaClient, event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = charge.payment_intent as string | null;
  if (!paymentIntentId) return;

  const purchase = await prisma.purchase.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    include: { product: true },
  });
  if (!purchase) {
    console.warn(`[stripe] refund for unknown payment intent ${paymentIntentId}`);
    return;
  }

  const minutes = purchase.product.durationMinutes ?? 0;
  const { applied } = await applyWalletTransaction(prisma, {
    userId: purchase.userId,
    type: "REFUND",
    amount: -minutes,
    unit: "MINUTE",
    referenceType: "purchase",
    referenceId: purchase.id,
    idempotencyKey: `stripe:${event.id}`,
    clampAtZero: true,
    metadata: { chargeId: charge.id, requestedMinutes: minutes },
  });

  await prisma.purchase.update({ where: { id: purchase.id }, data: { status: "REFUNDED" } });

  const shortfall = minutes - Math.abs(applied);
  if (shortfall > 0) {
    console.warn(
      `[stripe] refund on purchase ${purchase.id}: ${shortfall} minutes were already spent — admin case`
    );
  }
}

async function handleDispute(prisma: PrismaClient, event: Stripe.Event) {
  const dispute = event.data.object as Stripe.Dispute;
  const paymentIntentId = dispute.payment_intent as string | null;
  if (!paymentIntentId) return;

  const purchase = await prisma.purchase.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    include: { product: true, user: true },
  });
  if (!purchase) return;

  await applyWalletTransaction(prisma, {
    userId: purchase.userId,
    type: "REVERSAL",
    amount: -(purchase.product.durationMinutes ?? 0),
    unit: "MINUTE",
    referenceType: "purchase",
    referenceId: purchase.id,
    idempotencyKey: `stripe:${event.id}`,
    clampAtZero: true,
    metadata: { disputeId: dispute.id, reason: dispute.reason },
  });

  // A dispute suspends the account until it is resolved. Suspension is checked
  // in requireAuth and in the peer-set query, so it disconnects them too.
  await prisma.user.update({ where: { id: purchase.userId }, data: { status: "SUSPENDED" } });
  await prisma.session.deleteMany({ where: { userId: purchase.userId } });
  console.warn(`[stripe] dispute ${dispute.id}: suspended user ${purchase.userId}`);
}
