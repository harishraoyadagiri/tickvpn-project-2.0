import { execSync } from "child_process";
import { isValidWireGuardKey } from "../src/lib/wireguard";
const gen = () => execSync("wg genkey | wg pubkey", { encoding: "utf8",
  env: { ...process.env, PATH: `${process.env.PATH}:/usr/sbin` } }).trim();
let bad = 0;
const lastChars = new Set<string>();
for (let i = 0; i < 500; i++) {
  const k = gen();
  lastChars.add(k[42]);
  if (!isValidWireGuardKey(k)) { bad++; if (bad < 4) console.log("  rejected:", k); }
}
console.log(`500 real WireGuard keys -> ${bad} rejected`);
console.log("final characters seen:", [...lastChars].sort().join(""));
console.log("junk rejected:", !isValidWireGuardKey("not-a-key!!"), !isValidWireGuardKey("A".repeat(44)));
process.exit(bad === 0 ? 0 : 1);
