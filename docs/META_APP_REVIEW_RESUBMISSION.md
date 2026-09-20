# Meta app review resubmission

## What the September 9 review means

Meta accepted the described use cases. The rejected permissions were rejected
because the recordings did not prove the complete workflow. This is primarily a
review-evidence problem, not a prohibition on the product.

Approved permissions:

- `instagram_business_basic`
- `instagram_business_manage_messages`
- `pages_show_list`
- `pages_manage_metadata`
- `pages_messaging`
- `public_profile`

The Connected Accounts screen is the source of truth for readiness. It now
lists Direct Instagram, Page-linked Instagram, and Facebook Page capabilities
separately, with the selected account and exact missing permission.

## Production configuration

- Keep `SOCIAL_PUBLISHING_ENABLED=true`.
- Keep `META_AUTOMATIC_REPLIES_ENABLED=false` during review. Reviewers should
  see a human perform the action.
- In the Meta dashboard, add every requested Facebook/legacy Instagram
  permission to the **Facebook Login for Business configuration** referenced by
  `FACEBOOK_LOGIN_CONFIG_ID`.
- In the Instagram API product, configure Direct Instagram Login with the
  `instagram_business_*` permissions.
- Confirm production OAuth redirect URIs and webhook callback/verify token.
- After changing permissions or receiving approval, disconnect and reconnect
  the test account in Lead Porch. An old token does not gain new permissions.

## Recording rules for every submission

Record in English at readable zoom. Use a fresh private browser window and do
not edit the video in a way that hides the continuity of the workflow.

Every recording must show, in this order:

1. The user starts disconnected in Lead Porch.
2. The complete Facebook or Instagram login and consent flow.
3. The user returns to Lead Porch and selects the Page or Instagram account.
4. Connected Accounts shows that exact selected account and the capability as
   **Ready**.
5. The user performs the live action inside Lead Porch.
6. The result is shown in the native Facebook, Messenger, or Instagram client.

Use a unique phrase and timestamp in each test action so Meta can see that the
native result is the action just performed in Lead Porch.

## Required end-to-end recordings

### Facebook publishing — `pages_manage_posts`

Select the Facebook Page, create an image post in Lead Porch, approve it,
publish it, show the successful provider receipt, then open the native Page and
show the identical post.

### Direct Instagram publishing — `instagram_business_content_publish`

Use **Connect Instagram only**, select the professional account, create and
publish an image post in Lead Porch, then show the identical post in the native
Instagram profile.

### Page-linked Instagram publishing — `instagram_basic`, `instagram_content_publish`

Use **Connect Facebook + linked Instagram**, select the linked Instagram
account, publish an image post, and show the identical post in Instagram.

### Messenger — `pages_messaging`

From a separate personal test account, message the Page first. Show the inbound
conversation in Lead Porch, select the Page visibly, send a uniquely worded
reply in Lead Porch, and show that exact reply delivered in Messenger.

### Direct Instagram messaging — `instagram_business_manage_messages`

From a separate Instagram account, DM the professional account first. Show the
thread in Lead Porch, send a uniquely worded reply, and show that reply in the
native Instagram client. The customer-initiated conversation is required.

### Page-linked Instagram messaging — `instagram_manage_messages`

Repeat the messaging flow after using **Connect Facebook + linked Instagram**.
The selected linked account, Lead Porch send action, and identical native
delivery must all be visible.

### Facebook comments — `pages_read_user_content`, `pages_read_engagement`, `pages_manage_engagement`

From a separate personal account, leave a comment on a Page post. Show it
arrive in Lead Porch. Demonstrate reply, like as Page, hide, unhide, and delete,
showing the corresponding native Facebook state after each action.

### Direct Instagram comments — `instagram_business_manage_comments`

From a separate Instagram account, comment on a post. Show the comment in Lead
Porch, reply from Lead Porch, and show the reply in native Instagram. Also show
the available moderation action and its native result.

### Page-linked Instagram comments — `instagram_manage_comments`

Repeat the Instagram comment workflow using **Connect Facebook + linked
Instagram** and make the selected linked account visible.

### Facebook insights — `read_insights`

Select a Page that has real activity, open Analytics in Lead Porch, show Page
followers and engagements, and then show the corresponding Page/Professional
dashboard so the reviewer can recognize the asset and data source.

### Instagram insights — `instagram_business_manage_insights` or `instagram_manage_insights`

Record Direct Instagram and Page-linked Instagram separately. Select the
account, open Lead Porch Analytics, and show followers, reach, and profile views
for the same account in the native professional dashboard.

## Before resubmitting

- Every requested permission has its own recording or a clearly labeled video
  segment that proves the exact use case.
- Test accounts own or administer the assets used in the recording.
- The assets contain a real post, comment, conversation, and recent insights.
- Webhooks are subscribed and receiving live events.
- No capability row says **Needs Meta setup**.
- Submission notes identify which login path is used: Direct Instagram Login or
  Facebook Login for Business with a Page-linked Instagram account.
- Reviewer credentials and exact click-by-click navigation are included.
