import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Windows can assign an ephemeral port that Fetch reserves for another protocol.
// Keep HTTP fixtures off those ports without weakening Fetch's safety checks.
const reservedFetchPorts = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

export async function getFreePort(): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const assigned = (s.address() as AddressInfo).port;
        s.close((err) => (err ? reject(err) : resolve(assigned)));
      });
    });
    if (port >= 1024 && port < 65535 && !reservedFetchPorts.has(port)) {
      return port;
    }
  }
}
