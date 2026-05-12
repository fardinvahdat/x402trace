import { Hono } from "hono";

export interface MockSettleRecord {
  readonly receivedAt: string;
  readonly network: string;
  readonly payer: string;
  readonly payTo: string;
  readonly amount: string;
  readonly transaction: string;
}

export interface MockVerifyResponse {
  readonly isValid: boolean;
  readonly invalidReason?: string;
}

export interface MockFacilitatorOptions {
  /** Stub the /verify response. Default: { isValid: true }. */
  readonly verifyResponse?: MockVerifyResponse;
  /** If set, /settle returns success:false with this errorReason. */
  readonly settleErrorReason?: string;
}

export interface MockFacilitator {
  readonly app: Hono;
  readonly settlements: ReadonlyArray<MockSettleRecord>;
  reset(): void;
}

/**
 * Builds a mock x402 facilitator that returns canned /verify and /settle
 * responses. Implements the v1 protocol's POST /verify and POST /settle
 * exactly as x402's useFacilitator client expects them. The signature is NOT
 * cryptographically validated — that's intentional. This is for proving the
 * server/client wiring without on-chain USDC.
 *
 * Pass `verifyResponse` / `settleErrorReason` to simulate facilitator-side
 * failures (insufficient_balance, invalid_signature, expired authorization,
 * etc.) so failure-path tests can run hermetically without hitting the real
 * x402.org/facilitator.
 *
 * Never deploy this. It is a local-only test harness.
 */
export function createMockFacilitator(options: MockFacilitatorOptions = {}): MockFacilitator {
  const app = new Hono();
  const settlements: MockSettleRecord[] = [];

  app.get("/", (c) =>
    c.json({
      service: "x402trace-mock-facilitator",
      warning: "ALWAYS-APPROVES (unless configured otherwise). Local test harness only.",
      endpoints: ["POST /verify", "POST /settle"],
    }),
  );

  app.post("/verify", async (c) => {
    const body = (await c.req.json()) as {
      paymentPayload?: { payload?: { authorization?: { from?: string } } };
    };
    const payer = body.paymentPayload?.payload?.authorization?.from ?? "0x0";
    const stub = options.verifyResponse;
    if (stub && !stub.isValid) {
      return c.json({ isValid: false, invalidReason: stub.invalidReason, payer });
    }
    return c.json({ isValid: true, payer });
  });

  app.post("/settle", async (c) => {
    const body = (await c.req.json()) as {
      paymentPayload?: {
        network?: string;
        payload?: { authorization?: { from?: string; to?: string; value?: string } };
      };
    };
    const payload = body.paymentPayload;
    const auth = payload?.payload?.authorization;
    const network = payload?.network ?? "base-sepolia";
    const payer = auth?.from ?? "0x0";
    if (options.settleErrorReason) {
      return c.json({
        success: false,
        errorReason: options.settleErrorReason,
        network,
        payer,
        transaction: "",
      });
    }
    const record: MockSettleRecord = {
      receivedAt: new Date().toISOString(),
      network,
      payer,
      payTo: auth?.to ?? "0x0",
      amount: auth?.value ?? "0",
      transaction: synthTxHash(settlements.length + 1),
    };
    settlements.push(record);
    return c.json({
      success: true,
      transaction: record.transaction,
      network: record.network,
      payer: record.payer,
    });
  });

  return {
    app,
    get settlements() {
      return settlements;
    },
    reset() {
      settlements.length = 0;
    },
  };
}

function synthTxHash(seed: number): `0x${string}` {
  // Deterministic-but-unique synthetic hash so each settlement is distinguishable
  // in test output. NOT a real Ethereum hash.
  const seedHex = seed.toString(16).padStart(8, "0");
  return `0x${"f".repeat(56)}${seedHex}` as `0x${string}`;
}
