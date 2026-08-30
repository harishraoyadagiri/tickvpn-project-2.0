import express, { Router } from "express";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../lib/auth";
import { applyWalletTransaction } from "../services/walletService";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder", {
  apiVersion: "2024-06-20",
});

export function checkoutRouter(prisma: PrismaClient) {
  const router = Router();

  // POST /checkout { productId } -> { url }
  router.post("/checkout", requireAuth, async (req, res) => {
    const userId = (req as any).userId as string;
    const { productId } = req.body;

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || !product.active) return res.status(404).json({ error: "Product not found" });

    const purchase = await prisma.purchase.create({
      data: {
        userId,
        productId,
        amountCents: product.priceCents,
        status: "PENDING",
      },
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
      success_url: `${process.env.APP_URL}/dashboard?purchase=pending`,
      cancel_url: `${process.env.APP_URL}/pricing?purchase=cancelled`,
      client_reference_id: purchase.id,
      metadata: { purchaseId: purchase.id, userId, productId },
    });

    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { stripeSessionId: session.id },
    });

    // Note: this response only gives the client a URL to redirect to.
    // It does NOT credit the wallet. Only the webhook below does that.
    return res.json({ url: session.url });
  });

  return router;
}

// Mounted separately with express.raw() body parsing — Stripe signature
// verification requires the raw, unparsed request body.
export function webhookRouter(prisma: PrismaClient) {
  const router = Router();

  router.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const sig = req.headers["stripe-signature"] as string;
      let event: Stripe.Event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET || ""
        );
      } catch (err: any) {
        console.error("Webhook signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const purchaseId = session.metadata?.purchaseId;
        const userId = session.metadata?.userId;
        const productId = session.metadata?.productId;

        if (!purchaseId || !userId || !productId) {
          console.error("Missing metadata on session", session.id);
          return res.status(200).json({ received: true }); // ack, but don't credit
        }

        const product = await prisma.product.findUnique({ where: { id: productId } });
        if (!product) return res.status(200).json({ received: true });

        // Idempotency key = the Stripe event id. Prisma's unique constraint
        // on WalletTransaction.idempotencyKey makes replays a no-op.
        const isTimePack = product.kind === "TIME_PACK";
        const { alreadyApplied } = await applyWalletTransaction(prisma, {
          userId,
          type: "PURCHASE",
          amount: isTimePack ? product.durationMinutes ?? 0 : product.vpnDays ?? 0,
          unit: isTimePack ? "MINUTE" : "DAY",
          referenceType: "purchase",
          referenceId: purchaseId,
          idempotencyKey: `stripe:${event.id}`,
          metadata: { stripeSessionId: session.id },
        });

        await prisma.purchase.update({
          where: { id: purchaseId },
          data: {
            status: "PAID",
            stripePaymentIntentId: session.payment_intent as string,
          },
        });

        if (alreadyApplied) {
          console.log(`Webhook ${event.id} already processed — skipped double credit.`);
        }
      }

      return res.status(200).json({ received: true });
    }
  );

  return router;
}
