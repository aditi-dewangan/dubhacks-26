# This is all a kiosk vendor adds

```ts
import { AccessKiosk } from "@kiosk-access/sdk";

const access = AccessKiosk.connect({ serverUrl, kioskId, kioskKey });
access.onPairingCode((url) => showQrCode(url));
access.onSession((s) => setAccessibleMode(s.active));
access.publishState(toKioskState());               // on every screen change
access.onCommand((cmd) => runAsTaps(cmd));         // returns { ok, error?, state }
```

The kiosk keeps its own UI and cart. The SDK handles the connection, pairing, reconnects and
command acks; the server checks every request against the menu, and payment starts only after
the customer confirms on their phone.
