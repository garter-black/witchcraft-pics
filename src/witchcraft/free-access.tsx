/* The public free-access surface at /free-access.

   Purpose: give an anonymous visitor a truthful, useful answer to "how do I
   use this without the owner's key?" — a directory of providers where THEY can
   sign up for their own free account and mint their OWN key. It is a signup
   directory, not a credential store: no key value is rendered anywhere here.

   Honesty rules baked in (root review):
   - No "never store" claim: the studio seals a visitor's provider credential
     into an encrypted ~24h cookie, so it does hold it briefly. Not stated.
   - No provider is presented as working in the studio: every entry is signup
     only, integration pending — the page does not invite pasting a researched
     provider's key into the studio yet.
   - RunPod and Higgsfield are the visitor's own PAID accounts, never free
     credits and never owner-funded for visitors.
   - The studio's own renderer is stated as owner-restricted, so the public
     understands the studio itself is not open to them. */

import { FREE_CAVEATS, FREE_OPTIONS, SUPPORTED_LANES } from "./free-access-data";

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="wc-free-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span aria-hidden> ↗</span>
    </a>
  );
}

export function FreeAccess() {
  return (
    <main className="wc-free" aria-labelledby="wc-free-title">
      <a className="wc-free-back" href="/">
        ← BACK TO WITCHCRAFT
      </a>

      <header className="wc-free-head">
        <span className="wc-free-eyebrow">FREE ACCESS</span>
        <h1 id="wc-free-title">Find a free AI account.</h1>
        <p className="wc-free-lede">
          Witchcraft runs on keys you bring yourself. These providers offer a free account you
          can sign up for directly, so you can use your own key. A free tier is a free{" "}
          <em>account</em>, not a shared key: each one has its own limits, and you mint your own
          secret at the provider.
        </p>
        <p className="wc-free-lede wc-free-lede--pending">
          None of these providers are connected to this studio yet — they are signup options,
          not an integrated feature. The studio currently accepts provider keys only for the
          paid routes below.
        </p>
      </header>

      <section className="wc-free-supported" aria-labelledby="wc-free-supported-title">
        <h2 id="wc-free-supported-title">Supported in the studio today (paid / owner)</h2>
        <p className="wc-free-supported-lede">
          These are the lanes the studio can already use. The studio renderer is the owner's own
          machine and is owner-restricted; RunPod and Higgsfield are paid, account-based providers
          you connect with your own key. None of these are free credits.
        </p>
        <ul className="wc-free-lanes">
          {SUPPORTED_LANES.map((lane) => (
            <li key={lane.id} className="wc-free-lane" data-paid={lane.paid}>
              <div className="wc-free-lane-name">
                {lane.name}
                <span className="wc-free-tag" data-kind="supported">
                  Supported here
                </span>
              </div>
              <p className="wc-free-lane-copy">{lane.wording}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="wc-free-options" aria-labelledby="wc-free-options-title">
        <h2 id="wc-free-options-title">Free signup options (integration pending)</h2>
        <p className="wc-free-options-lede">
          Each of these has a free account you can create yourself. None are{" "}
          <strong>connected to this studio yet</strong> — the signup is the first step, and wiring
          them in is still pending. Free text is not the same as free image or video; the
          capabilities below state only what each provider's own docs prove.
        </p>
        <ul className="wc-free-grid">
          {FREE_OPTIONS.map((option) => (
            <li key={option.id} className="wc-free-card">
              <div className="wc-free-card-head">
                <h3 className="wc-free-card-name">{option.name}</h3>
                <span className="wc-free-tag" data-kind="pending">
                  Signup only — not yet connected here
                </span>
              </div>
              <dl className="wc-free-card-body">
                <dt>Can make</dt>
                <dd>{option.capabilities}</dd>
                <dt>Free offer</dt>
                <dd>{option.offer}</dd>
                <dt>Limits</dt>
                <dd>{option.limits}</dd>
                <dt>Card needed</dt>
                <dd>{option.card}</dd>
              </dl>
              <div className="wc-free-card-links">
                <ExternalLink href={option.signupUrl}>Create a free account</ExternalLink>
                <ExternalLink href={option.docsUrl}>Official docs</ExternalLink>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="wc-free-caveats" aria-labelledby="wc-free-caveats-title">
        <h2 id="wc-free-caveats-title">Before you sign up</h2>
        <ul>
          {FREE_CAVEATS.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
