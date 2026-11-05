/**
 * Stripe.js for the payment agent (core docs/PAY-AGENT.md): loaded on demand from js.stripe.com — never bundled,
 * never self-hosted (Stripe's PCI rule). The card is typed into Stripe's Payment Element iframe; Nokker only ever
 * receives a `pm_…` id. URL from Stripe's Shared Payment Tokens guide (preview channel « endive », read 02.11.2026).
 */
export const STRIPE_JS = "https://js.stripe.com/endive/stripe.js";

export interface StripeElement {
  mount(el: HTMLElement): void;
  destroy(): void;
}
export interface StripeElements {
  create(kind: "payment", opts?: Record<string, unknown>): StripeElement;
  submit(): Promise<{ error?: { message?: string } }>;
}
export interface StripeLike {
  elements(opts: Record<string, unknown>): StripeElements;
  preparePaymentMethod(args: { elements: StripeElements; params?: Record<string, unknown> }): Promise<{
    error?: { message?: string };
    paymentMethod?: { id: string };
  }>;
  handleNextAction(args: { hashedValue: string }): Promise<{ error?: { message?: string } } | undefined>;
}

type StripeCtor = (key: string) => StripeLike;
let loading: Promise<StripeCtor> | null = null;

function loadScript(): Promise<StripeCtor> {
  const w = window as unknown as { Stripe?: StripeCtor };
  if (w.Stripe) return Promise.resolve(w.Stripe);
  if (!loading) {
    loading = new Promise<StripeCtor>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = STRIPE_JS;
      s.async = true;
      s.onload = () => (w.Stripe ? resolve(w.Stripe) : reject(new Error("Stripe.js")));
      s.onerror = () => {
        loading = null;
        reject(new Error("Stripe.js"));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

const instances = new Map<string, StripeLike>();

export async function stripeFor(publishableKey: string): Promise<StripeLike> {
  if (!/^pk_(test|live)_[A-Za-z0-9]+$/.test(publishableKey)) throw new Error("publishable key");
  const hit = instances.get(publishableKey);
  if (hit) return hit;
  const s = (await loadScript())(publishableKey);
  instances.set(publishableKey, s);
  return s;
}

/** Payment Element options to REGISTER a method (no amount, no seller yet: the token is bound per purchase later). */
export const SETUP_OPTIONS = { mode: "setup", currency: "chf", paymentMethodCreation: "manual" } as const;
