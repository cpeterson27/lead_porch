# LinkedIn outreach setup

Lead Porch uses Unipile for personal-profile LinkedIn messaging. This is
separate from the official LinkedIn organization-page publishing connection.

## Render environment

Set these values on the backend web service (and on the background worker too,
if `LINKEDIN_SEQUENCE_WORKER_MODE=external`):

```text
LINKEDIN_UNIPILE_ENABLED=true
UNIPILE_DSN=<the DSN shown in the Unipile API dashboard>
UNIPILE_API_KEY=<a Unipile access token>
UNIPILE_WEBHOOK_TOKEN=<a new random secret of at least 32 bytes>
PUBLIC_BACKEND_URL=https://<the public backend host>
FRONTEND_URL=https://<the Lead Porch app host>
```

Optional worker tuning:

```text
LINKEDIN_SEQUENCE_WORKER_POLL_MS=300000
LINKEDIN_ACCEPTANCE_RECHECK_MS=1800000
```

Do not set `LINKEDIN_SEQUENCE_WORKER_MODE=external` unless a separate Render
worker service runs `npm run start:worker` from the backend package.

## First connection

1. Deploy the backend with the environment values above.
2. In Lead Porch, open **Social > LinkedIn outreach**.
3. Confirm **Unipile API configured** is green.
4. Click **Connect LinkedIn**. Ellie completes the hosted LinkedIn login and
   any LinkedIn verification challenge; Lead Porch never receives her raw
   password.
5. Return to LinkedIn outreach and click **Sync LinkedIn inbox** once. This
   verifies the live-message webhook and imports existing conversations.
6. Confirm LinkedIn conversations appear under **Social > Inbox**.

## Safe operating workflow

1. Find prospects through Apollo/Public Research, social engagement, CRM
   imports, or the manual LinkedIn preview search.
2. Review the person and add only appropriate people to the CRM.
3. Create a sequence. Keep the defaults of 20 invitations per rolling 24 hours
   and 5 per rolling hour for the first live test.
4. Keep **Let AI send replies automatically** off during the initial test.
5. Enroll 5-10 contacts, activate the sequence, and watch delivery and replies.
6. Review reply drafts or respond in the unified Social Inbox.
7. Expand gradually only after acceptance, reply, and account-health results
   are normal.

Pausing a sequence prevents unsent steps from running. Disconnecting the
LinkedIn account automatically pauses every active sequence in that workspace.

## What is deliberately prohibited

- No person is contacted directly from a search result.
- No background search automatically creates CRM contacts.
- No sequence enrolls a contact without a saved LinkedIn URL.
- A person cannot be active in multiple sequences at once.
- Incoming replies cancel the person's remaining timed follow-ups.
- Connection requests expire from the active runner after 30 days.
- AI replies require human review unless the sequence owner explicitly enables
  autonomous sending.

LinkedIn and Unipile limits still apply. The application-enforced hourly and
daily limits are additional safety controls, not permission to send spam or to
ignore LinkedIn's terms.
