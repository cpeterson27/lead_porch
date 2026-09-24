import { Link } from "react-router-dom";
import useWorkspaceTheme from "../context/useWorkspaceTheme.js";
import { PublicLayout } from "./PublicSite.jsx";
import "./PublicLegal.css";

const effectiveDate = "August 28, 2026";

function ContactMethod({ purpose = "privacy request" }) {
  const { site } = useWorkspaceTheme();
  const email = site?.publicSite?.contactEmail || "";
  if (!email) return <span>the contact email listed on this website</span>;
  const subject = encodeURIComponent(
    `${site?.workspace?.name || "Website"} ${purpose}`,
  );
  return <a href={`mailto:${email}?subject=${subject}`}>{email}</a>;
}

// This page is served for every Lead Porch tenant's own public site — it
// must never read as another business's legal document. Confirmed live:
// these pages hardcoded the literal text "Lead Porch" and "leadporch.co"
// throughout, so every customer's Privacy Policy/Terms/Data Deletion pages
// named a different company (Lead Porch, the platform vendor) instead of
// their own business. businessName/domain are resolved per-request from
// the actual workspace and hostname serving the page.
function useLegalIdentity() {
  const { site } = useWorkspaceTheme();
  const businessName =
    site?.branding?.publicSiteName || site?.workspace?.name || "this business";
  const domain =
    typeof window !== "undefined"
      ? window.location.hostname.replace(/^www\./, "")
      : "";
  return { businessName, domain };
}

function LegalShell({ eyebrow, title, intro, children }) {
  return (
    <PublicLayout>
      <main id="main-content" className="public-inner legal-page">
        <header className="legal-page__hero">
          <p className="public-kicker">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{intro}</p>
          <small>Effective date: {effectiveDate}</small>
        </header>
        <article className="public-prose legal-page__content">
          {children}
        </article>
      </main>
    </PublicLayout>
  );
}

export function PrivacyPage() {
  const { businessName, domain } = useLegalIdentity();
  return (
    <LegalShell
      eyebrow="Privacy & trust"
      title="Privacy Policy"
      intro={`This policy explains how ${businessName} uses information through this website, contact forms, communications, and authorized service connections.`}
    >
      <section>
        <h2>1. Scope</h2>
        <p>
          This Privacy Policy applies to the {businessName} public website at{" "}
          {domain}, its contact experience, and related communications and
          integrations operated through {businessName}. Private services you use
          directly—including social networks, event platforms, payment
          providers, calendar services, video-meeting services, and community
          platforms—also apply their own privacy policies.
        </p>
      </section>
      <section>
        <h2>2. Account, profile, and application information</h2>
        <p>We process information you choose to provide, which may include:</p>
        <ul>
          <li>
            Your name, email address, phone number, profile information, account
            role, and communication preferences.
          </li>
          <li>
            The program you select and your application answers, including
            experience, current situation, goals, desired timing, and an
            optional message.
          </li>
          <li>
            Information included in messages, replies, forms, meetings, event
            registrations, or other interactions with {businessName}.
          </li>
          <li>
            Consent records for email or text communications and requests to opt
            out.
          </li>
        </ul>
        <p>
          Submitting a program application creates or updates a workspace-scoped
          CRM contact and related business record so the {businessName} team can
          review the application, preserve attribution, communicate about next
          steps, and avoid unnecessary duplicate records.
        </p>
      </section>
      <section>
        <h2>3. Technical data, cookies, and browser storage</h2>
        <p>
          When you use the site, the application and its hosting providers may
          receive ordinary technical information such as an IP address, browser
          or device details, requested pages, timestamps, referral parameters,
          and diagnostic or security logs. {businessName} uses browser storage and
          may use essential cookies for limited interface, security, and
          authenticated-session functions. The current public website does not
          claim to use advertising cookies or sell browsing profiles. If
          additional analytics or advertising technologies are introduced, this
          policy should be updated before they are activated.
        </p>
      </section>
      <section>
        <h2>4. Facebook, Instagram, and Meta data</h2>
        <p>
          When an authorized {businessName} administrator connects selected Facebook
          Pages or professional Instagram accounts through Meta’s official
          authorization flow, {businessName} may process:
        </p>
        <ul>
          <li>
            The connected Meta account’s basic identifier and display name.
          </li>
          <li>The permissions Meta actually grants or declines.</li>
          <li>
            Identifiers and names for the Facebook Pages and professional
            Instagram accounts the administrator is permitted to manage and
            chooses to use.
          </li>
          <li>
            Encrypted authorization credentials, authorization status, and
            webhook-subscription status needed to maintain the connection.
          </li>
          <li>
            Supported events delivered by Meta for selected assets, such as
            messages, story replies, comments, public account identifiers or
            usernames, post or media identifiers, and event timestamps.
          </li>
        </ul>
        <p>
          This information may be used to associate a supported interaction with
          a workspace-scoped CRM contact, preserve conversation history and
          attribution, create a tracked resource or application link, and
          support team follow-up. {businessName} does not receive or store Facebook
          or Instagram passwords. It does not claim access to private profiles,
          personal inboxes, unrelated Pages or accounts, or information outside
          the permissions and assets authorized through Meta.
        </p>
        <p>
          Automated replies and publishing are controlled features and are not
          enabled merely because an account is connected.
        </p>
      </section>
      <section>
        <h2>5. How information is used</h2>
        <ul>
          <li>
            To operate accounts, profiles, the website, and program
            applications.
          </li>
          <li>
            To review program fit, respond to questions, and manage permitted
            communications.
          </li>
          <li>
            To maintain CRM contacts, conversations, engagement history, source
            attribution, opportunities, and other business records.
          </li>
          <li>
            To provide AI-assisted analysis, drafting, classification, or
            recommendations when an authorized workspace feature is enabled. AI
            assistance does not automatically publish content or send a provider
            message merely because it is available.
          </li>
          <li>
            To connect and operate third-party services when an authorized user
            requests it.
          </li>
          <li>
            To protect accounts, troubleshoot problems, prevent duplicate
            processing, and maintain service integrity.
          </li>
          <li>
            To comply with applicable obligations and enforce appropriate terms.
          </li>
        </ul>
      </section>
      <section>
        <h2>6. Service providers and connected services</h2>
        <p>
          Information may be processed by hosting, database, email, messaging,
          calendar, meeting, event, payment, community, social-media,
          automation, and other providers used to deliver an authorized feature.
          Examples this website's platform supports include Render, MongoDB, Meta,
          Google, Zoom, Twilio, Resend, Stripe, Eventbrite, Skool, Zapier,
          Gmail, and Monday. A provider receives information only when its
          feature is configured and used. Connecting one provider does not
          activate every other integration.
        </p>
      </section>
      <section>
        <h2>7. Selling and disclosure</h2>
        <p>
          {businessName} does not sell personal information. Information may be
          disclosed to service providers that help operate requested features;
          to authorized {businessName} team members who need it for their work; when
          directed by the person or account owner; or when reasonably necessary
          for security, legal process, or protection of rights.
        </p>
      </section>
      <section>
        <h2>8. Communications and choices</h2>
        <p>
          Marketing email and application-related text preferences are recorded
          separately. You may unsubscribe using the link in a marketing email
          and may reply STOP to supported text messages. Transactional or
          application communications may still be sent when reasonably necessary
          to respond to your request. You may disconnect a Meta authorization
          through Meta’s settings, and you may also follow our{" "}
          <Link to="/data-deletion">data-deletion instructions</Link>.
        </p>
      </section>
      <section>
        <h2>9. Security</h2>
        <p>
          {businessName} uses safeguards designed for the sensitivity of the
          information it handles, including workspace access controls,
          role-based authorization, encrypted provider credentials, request
          validation, and provider-signature verification where supported. No
          internet or storage system can be guaranteed completely secure.
        </p>
      </section>
      <section>
        <h2>10. Retention</h2>
        <p>
          Information is retained for as long as reasonably needed to operate
          the requested relationship, maintain accurate business and consent
          records, protect the service, resolve disputes, and meet applicable
          obligations. The exact period can vary by record and context. Deletion
          requests are reviewed against these needs; limited records may remain
          in backups, security logs, or records that must be preserved.
        </p>
      </section>
      <section>
        <h2>11. Your rights and requests</h2>
        <p>
          Depending on where you live, you may have rights to request access,
          correction, deletion, or a copy of certain personal information, or to
          object to or restrict some processing. We may need to verify the
          request and may be unable to fulfill portions that must be retained or
          that concern another person. Contact <ContactMethod /> or see the{" "}
          <Link to="/data-deletion">data-deletion page</Link>.
        </p>
      </section>
      <section>
        <h2>12. Changes and contact</h2>
        <p>
          This policy may be updated as the website and authorized integrations
          change. Material changes should be reflected by updating the date
          above. Questions or privacy requests may be sent to{" "}
          <ContactMethod purpose="Privacy Request" />.
        </p>
      </section>
    </LegalShell>
  );
}

export function TermsPage() {
  const { businessName } = useLegalIdentity();
  return (
    <LegalShell
      eyebrow="Website terms"
      title="Terms of Service"
      intro={`These terms govern use of the ${businessName} public website and contact experience.`}
    >
      <section>
        <h2>1. Accepting these terms</h2>
        <p>
          By using this website or submitting a program application, you agree
          to these Terms of Service and acknowledge the{" "}
          <Link to="/privacy">Privacy Policy</Link>. If you do not agree, do not
          submit information or use the site.
        </p>
      </section>
      <section>
        <h2>2. Website purpose</h2>
        <p>
          The website provides information about {businessName}, published programs,
          events, team profiles, testimonials, and ways to apply or make
          contact. Website content is general information and may be updated,
          corrected, or removed.
        </p>
      </section>
      <section>
        <h2>3. Program applications</h2>
        <p>
          An application begins a review and conversation. It does not guarantee
          acceptance, enrollment, availability, a particular outcome, or access
          to a program. You agree to provide information that is accurate to the
          best of your knowledge and that you are authorized to submit.
        </p>
      </section>
      <section>
        <h2>4. Program terms and payments</h2>
        <p>
          If you are offered enrollment, the applicable program description and
          any separate enrollment, payment, cancellation, or other terms
          presented for that program will control that relationship. These
          website terms do not create a refund policy, pricing commitment,
          financing promise, or payment obligation.
        </p>
      </section>
      <section>
        <h2>5. Educational information; no guarantees</h2>
        <p>
          Coaching and website materials are educational and informational. They
          are not a substitute for legal, tax, accounting, investment, lending,
          or other licensed professional advice. Real-estate and business
          decisions involve risk. Examples, testimonials, and past experiences
          do not promise that another person will achieve the same result. You
          remain responsible for your decisions, due diligence, professional
          advice, and compliance obligations.
        </p>
      </section>
      <section>
        <h2>6. Acceptable use</h2>
        <p>
          You may not misuse the site, attempt unauthorized access, interfere
          with service operation, submit malicious code, impersonate another
          person, scrape or harvest information in violation of applicable
          rules, or use the site to violate law or another person’s rights.
        </p>
      </section>
      <section>
        <h2>7. Intellectual property</h2>
        <p>
          The website’s branding, text, graphics, program descriptions, and
          other materials are owned by or used with permission by {businessName}
          and may be protected by intellectual-property laws. You may
          use the public site for personal informational purposes, but may not
          reproduce or commercially exploit its content without permission
          except where law allows.
        </p>
      </section>
      <section>
        <h2>8. Third-party services and links</h2>
        <p>
          The site may link to or interact with services such as Meta, Google,
          Zoom, Eventbrite, Stripe, Skool, and other providers. Their services
          are governed by their own terms and privacy practices. {businessName}
          is not responsible for a third party’s independent service,
          availability, or content.
        </p>
      </section>
      <section>
        <h2>9. Service availability and disclaimers</h2>
        <p>
          The public site is provided on an “as available” basis. To the extent
          permitted by law, {businessName} disclaims warranties that are not
          expressly stated in a separate written agreement, including that the
          site will always be available or error-free. Nothing in these terms
          excludes rights or responsibilities that cannot legally be excluded.
        </p>
      </section>
      <section>
        <h2>10. Responsibility for loss</h2>
        <p>
          To the extent permitted by applicable law, {businessName} is not
          responsible for indirect or consequential loss arising solely from use
          of, or inability to use, the public website. This section does not
          limit responsibility that cannot legally be limited and does not
          replace any separate written program agreement.
        </p>
      </section>
      <section>
        <h2>11. Changes</h2>
        <p>
          These terms may be updated as the website or program-application
          experience changes. The date above identifies the current version.
          Continued use after an update means the updated terms apply to later
          use.
        </p>
      </section>
      <section>
        <h2>12. Contact</h2>
        <p>
          Questions about these terms may be sent to{" "}
          <ContactMethod purpose="Terms Question" />.
        </p>
      </section>
    </LegalShell>
  );
}

// Starter policy only — the Terms page (section 4) explicitly disclaims
// that these website terms set any refund/cancellation commitment, so this
// page existed as a gap rather than a placeholder. The specific terms below
// (no refunds once coaching has begun, a 3-business-day change-of-mind
// window before the first session, rescheduling instead of refunding a
// missed live session) are a conservative, industry-common default for
// coaching programs — not a real commitment yet. Update this page directly
// once the business owner has actually decided the real policy.
export function RefundPolicyPage() {
  const { businessName } = useLegalIdentity();
  return (
    <LegalShell
      eyebrow="Payments & enrollment"
      title="Refund & Cancellation Policy"
      intro={`This page explains how refunds, cancellations, and rescheduling work for ${businessName}'s coaching programs.`}
    >
      <section>
        <h2>1. Before your program starts</h2>
        <p>
          If you change your mind before your program begins, contact us
          within 3 business days of enrolling and before your first coaching
          session, and we will cancel your enrollment and refund payments
          already made toward that program.
        </p>
      </section>
      <section>
        <h2>2. Once your program has begun</h2>
        <p>
          Coaching time, preparation, and program materials are reserved for
          you personally once your first session has taken place. Payments
          made for sessions or program access already delivered are
          non-refundable from that point forward.
        </p>
      </section>
      <section>
        <h2>3. Payment plans</h2>
        <p>
          If you are enrolled on an installment payment plan, each
          installment remains due on its scheduled date regardless of session
          attendance, and installments already paid are handled under the
          same terms as section 2 above. Contact us if you are having
          difficulty making a scheduled payment — we would rather work out a
          plan with you than send it to collections.
        </p>
      </section>
      <section>
        <h2>4. Missed or rescheduled sessions</h2>
        <p>
          A session you cannot attend is not refunded, but we will work with
          you to reschedule it within a reasonable window when you give
          advance notice. Repeated no-shows without notice may be treated as
          a completed session.
        </p>
      </section>
      <section>
        <h2>5. Cancelling an ongoing enrollment</h2>
        <p>
          You may cancel your ongoing enrollment at any time by contacting
          us. Cancellation stops future billing going forward; it does not
          refund sessions or program access already delivered.
        </p>
      </section>
      <section>
        <h2>6. Contact</h2>
        <p>
          Questions about a specific payment, refund, or cancellation should
          be sent to <ContactMethod purpose="Refund/Cancellation Question" />.
        </p>
      </section>
    </LegalShell>
  );
}

export function DataDeletionPage() {
  const { businessName } = useLegalIdentity();
  return (
    <LegalShell
      eyebrow="Meta user-data request"
      title="Facebook & Instagram Data Deletion Instructions"
      intro={`Use these instructions to request deletion of information associated with a Facebook or Instagram interaction or authorization processed by ${businessName}.`}
    >
      <section
        className="legal-callout"
        aria-labelledby="deletion-request-heading"
      >
        <h2 id="deletion-request-heading">How to submit a deletion request</h2>
        <ol>
          <li>
            Email <ContactMethod purpose="Meta Data Deletion Request" /> with
            the subject <strong>Meta Data Deletion Request</strong>.
          </li>
          <li>
            State that your request concerns Facebook, Instagram, or a Meta
            authorization.
          </li>
          <li>
            Provide enough information to locate the records: your name; an
            email address we can use to respond; your Facebook or Instagram
            username or profile URL; the relevant Facebook Page or professional
            Instagram account name, if applicable; the approximate date of the
            interaction or connection; and a short description of what you want
            deleted.
          </li>
          <li>
            Do not send your Facebook or Instagram password, an access token, an
            authorization code, a webhook secret, or any other account
            credential. {businessName} will never ask for those items to process a
            deletion request.
          </li>
        </ol>
      </section>
      <section>
        <h2>What happens next</h2>
        <p>
          A team member will review the request and may ask for limited
          additional information needed to verify that the requester is the
          person concerned or is authorized to act for the connected business
          asset. There is no claim that this process is fully automated. Once
          verified, {businessName} will identify and delete or de-identify
          applicable workspace records, which may include the associated social
          identity link, supported Meta event records, conversation records, CRM
          contact information, tracked links, and program application
          information.
        </p>
        <p>
          If the request concerns a {businessName} business connection, any separate
          action involving stored Meta authorization must be explicitly
          confirmed by an authorized account administrator. Disconnecting it may
          affect the selected Facebook Page or professional Instagram account.
        </p>
      </section>
      <section>
        <h2>Disconnecting through Meta</h2>
        <p>
          You may also remove the app or revoke its permissions from your
          Facebook or Instagram settings. Revocation stops future authorized
          access after Meta processes it, but it may not by itself delete
          information already provided to {businessName}. Send the request above if
          you also want existing {businessName} records reviewed for deletion.
        </p>
      </section>
      <section>
        <h2>Limits and confirmation</h2>
        <p>
          Some information may be retained where reasonably necessary for
          security, fraud prevention, legal obligations, dispute resolution,
          consent or suppression records, or system backups. Where a request is
          completed, {businessName} will respond using the contact information
          supplied by the requester. Requests involving another person’s data
          cannot be fulfilled without appropriate authority.
        </p>
      </section>
      <section>
        <h2>Other privacy requests</h2>
        <p>
          For access, correction, or other privacy questions, review the{" "}
          <Link to="/privacy">Privacy Policy</Link> or contact{" "}
          <ContactMethod purpose="Privacy Request" />.
        </p>
      </section>
    </LegalShell>
  );
}
