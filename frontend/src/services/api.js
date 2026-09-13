import axios from "axios";

export const fetchSocialWorkspace = (section) =>
  api.get(`/social-workspace/${section}`).then((res) => res.data);
export const mutateSocialWorkspace = (section, values) =>
  api.post(`/social-workspace/${section}`, values).then((res) => res.data);
export const manageFacebookComment = (threadId, values) =>
  api
    .post(`/social-workspace/inbox/${threadId}/comment-actions`, values)
    .then((res) => res.data);
export const fetchAmbassadorNotifications = () =>
  api.get("/ambassadors/me/notifications").then((res) => res.data);
export const fetchAmbassadorContentTasks = () =>
  api.get("/ambassadors/me/content-tasks").then((res) => res.data);
export const updateAmbassadorContentTask = (id, values) =>
  api
    .patch(`/ambassadors/me/content-tasks/${id}`, values)
    .then((res) => res.data);

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "http://localhost:5001/api",
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  if (window.location.hostname) {
    config.headers["X-Public-Host"] = window.location.hostname;
  }
  return config;
});

export const getSocialInboxStreamUrl = () =>
  `${api.defaults.baseURL}/social-workspace/inbox/stream`;
export const getMcpEndpoint = () =>
  String(api.defaults.baseURL || "").replace(/\/api\/?$/, "/mcp");
export const getGptActionsSchemaEndpoint = () =>
  String(api.defaults.baseURL || "").replace(
    /\/api\/?$/,
    "/gpt-actions/openapi.json",
  );

export const fetchOAuthAuthorizationDetails = (search = "") =>
  api.get(`/oauth/authorize/details${search}`).then((res) => res.data);

export const approveOAuthConnection = (values) =>
  api.post("/oauth/authorize", values).then((res) => res.data);

export const fetchOAuthConnections = () =>
  api.get("/oauth/connections").then((res) => res.data);

export const revokeOAuthConnection = (clientId) =>
  api
    .delete(`/oauth/connections/${encodeURIComponent(clientId)}`)
    .then((res) => res.data);

export const fetchSocialConnection = (provider) =>
  api.get(`/social/${provider}/oauth/status`).then((res) => res.data);

export const beginSocialConnection = (provider) =>
  api.get(`/social/${provider}/oauth/start`).then((res) => res.data);

export const disconnectSocialConnection = (provider) =>
  api.post(`/social/${provider}/oauth/disconnect`).then((res) => res.data);

export const refreshInstagramAuthorization = () =>
  api.post("/social/instagram/oauth/refresh").then((res) => res.data);

export const selectSocialAssets = (provider, assetIds) =>
  api.patch(`/social/${provider}/assets`, { assetIds }).then((res) => res.data);

export const fetchMeetupStatus = () =>
  api.get("/meetup/status").then((res) => res.data.data);
export const beginMeetupConnection = () =>
  api.get("/meetup/oauth/start").then((res) => res.data);
export const disconnectMeetup = () =>
  api.post("/meetup/disconnect").then((res) => res.data.data);
export const fetchMeetupAssets = (network) =>
  api
    .get("/meetup/assets", { params: network ? { network } : {} })
    .then((res) => res.data.data);
export const selectMeetupGroups = (groupUrlnames) =>
  api.patch("/meetup/assets", { groupUrlnames }).then((res) => res.data.data);

export const fetchSocialAutomationOverview = () =>
  api.get("/social-automation/overview").then((res) => res.data.data);
export const recommendSocialAutomation = (values) =>
  api.post("/social-automation/recommend", values).then((res) => res.data.data);
export const generatePlatformMediaVariants = (contentId, mediaIndex, values) =>
  api.post(`/content/${contentId}/media/${mediaIndex}/variants`, values).then((res) => res.data.data);
export const replacePlatformMediaVariant = (contentId, mediaIndex, provider, values) =>
  api.patch(`/content/${contentId}/media/${mediaIndex}/variants/${provider}`, values).then((res) => res.data.data);
export const generateAiImage = (values) =>
  api.post("/content/generate-image", values).then((res) => res.data.data);
export const fetchSocialAutomations = (contentBriefId) =>
  api
    .get("/social-automation/automations", {
      params: contentBriefId ? { contentBriefId } : {},
    })
    .then((res) => res.data.data);
export const fetchSocialContactLabels = () =>
  api.get("/social-automation/contact-labels").then((res) => res.data.data);
export const createSocialContactLabel = (label) =>
  api
    .post("/social-automation/contact-labels", { label })
    .then((res) => res.data.data);
export const fetchSocialAutomationPosts = (provider, assetId) =>
  api
    .get("/social-automation/posts", { params: { provider, assetId } })
    .then((res) => res.data.data);
export const fetchSocialAutomationContentBriefs = (provider, assetId) =>
  api
    .get("/social-automation/content-briefs", { params: { provider, assetId } })
    .then((res) => res.data.data);
export const createSocialAutomation = (values) =>
  api
    .post("/social-automation/automations", values)
    .then((res) => res.data.data);
export const updateSocialAutomation = (id, values) =>
  api
    .patch(`/social-automation/automations/${id}`, values)
    .then((res) => res.data.data);
export const fetchSocialLeads = (params = {}) =>
  api.get("/social-automation/leads", { params }).then((res) => res.data.data);
export const createSocialTrackedLink = (values) =>
  api
    .post("/social-automation/tracked-links", values)
    .then((res) => res.data.data);
export const fetchAutomationCatalog = () =>
  api.get("/automations/catalog").then((res) => res.data.data);
export const fetchAutomations = () =>
  api.get("/automations").then((res) => res.data.data);
export const createAutomation = (values) =>
  api.post("/automations", values).then((res) => res.data.data);
export const createAutomationFromTemplate = (key) =>
  api.post(`/automations/from-template/${key}`).then((res) => res.data.data);
export const updateAutomation = (id, values) =>
  api.patch(`/automations/${id}`, values).then((res) => res.data.data);
export const updateAutomationStatus = (id, status) =>
  api
    .patch(`/automations/${id}/status`, { status })
    .then((res) => res.data.data);
export const fetchAutomationExecutions = (params = {}) =>
  api
    .get("/automations/executions/recent", { params })
    .then((res) => res.data.data);
export const retryAutomationExecution = (id) =>
  api.post(`/automations/executions/${id}/retry`).then((res) => res.data.data);
export const fetchGrowthAnalytics = () =>
  api.get("/analytics/growth").then((res) => res.data.data);

api.interceptors.request.use((config) => {
  const csrfToken = sessionStorage.getItem("ellie-csrf-token");
  const sessionToken = sessionStorage.getItem("ellie-session-token");
  if (csrfToken) config.headers["X-CSRF-Token"] = csrfToken;
  if (sessionToken) config.headers.Authorization = `Bearer ${sessionToken}`;
  return config;
});

export const fetchWorkspaceConfig = () =>
  api.get("/workspace").then((res) => res.data);

export const updateWorkspaceConfig = (values) =>
  api.patch("/workspace", values).then((res) => res.data);

export const fetchPrivacyRequests = () =>
  api.get("/privacy-requests").then((res) => res.data.data);
export const fetchPrivacyRequest = (id) =>
  api.get(`/privacy-requests/${id}`).then((res) => res.data.data);
export const updatePrivacyRequestStatus = (id, values) =>
  api
    .patch(`/privacy-requests/${id}/status`, values)
    .then((res) => res.data.data);
export const approvePrivacyRequest = (id, values) =>
  api
    .post(`/privacy-requests/${id}/approve`, values)
    .then((res) => res.data.data);

export const changePassword = (values) =>
  api.patch("/auth/password", values).then((res) => res.data);
export const uploadMyAvatar = (file) =>
  api.post("/auth/profile/avatar", { file }).then((res) => res.data);
export const fetchMyProfile = () =>
  api.get("/auth/profile").then((res) => res.data);
export const saveMyProfile = (profile) =>
  api.patch("/auth/profile", profile).then((res) => res.data);
export const removeMyAvatar = () =>
  api.delete("/auth/profile/avatar").then((res) => res.data);

export const fetchWorkspaceMembers = () =>
  api.get("/workspace/members").then((res) => res.data);

export const createWorkspaceMember = (values) =>
  api.post("/workspace/members", values).then((res) => res.data);
export const sendWorkspaceInvitation = (id, values = {}) =>
  api.post(`/workspace/invitations/${id}/send`, values).then((res) => res.data);
export const fetchWorkspaceInvitationPreview = (id) =>
  api
    .get(`/workspace/invitations/${id}/preview`)
    .then((res) => res.data.invitation);
export const cancelWorkspaceInvitation = (id) =>
  api.delete(`/workspace/invitations/${id}`).then((res) => res.data);
export const fetchInvitationTemplates = () =>
  api.get("/workspace/invitation-templates").then((res) => res.data.templates);
export const saveInvitationTemplate = (roleKey, values) =>
  api
    .put(`/workspace/invitation-templates/${roleKey}`, values)
    .then((res) => res.data.template);
export const resetInvitationTemplate = (roleKey) =>
  api
    .post(`/workspace/invitation-templates/${roleKey}/reset`)
    .then((res) => res.data.template);
export const updateWorkspaceMember = (id, values) =>
  api.patch(`/workspace/members/${id}`, values).then((res) => res.data);
export const removeWorkspaceMember = (id) =>
  api.delete(`/workspace/members/${id}`).then((res) => res.data);
export const fetchWorkspaceCapabilities = () =>
  api.get("/workspace/capabilities").then((res) => res.data);
export const saveWorkspaceRolePermissions = (role, permissions) =>
  api
    .put(`/workspace/role-permissions/${role}`, { permissions })
    .then((res) => res.data);
export const resetWorkspaceRolePermissions = (role) =>
  api.delete(`/workspace/role-permissions/${role}`).then((res) => res.data);
export const fetchPlatformBusinesses = () =>
  api.get("/platform/businesses").then((res) => res.data.businesses);
export const createPlatformWorkspace = (values) =>
  api.post("/platform/workspaces", values).then((res) => res.data.workspace);
export const updatePlatformWorkspaceHosts = (id, publicHosts) =>
  api
    .patch(`/platform/workspaces/${id}/public-hosts`, { publicHosts })
    .then((res) => res.data.workspace);
export const fetchLaunchReadiness = () =>
  api.get("/workspace/readiness").then((res) => res.data.data);
export const fetchPublicSite = () =>
  api
    .get("/public/site", {
      params: {
        publicHost: window.location.hostname,
        publicPath: window.location.pathname,
      },
    })
    .then((res) => res.data.data);
export const fetchPublicProgram = (slug) =>
  api.get(`/public/programs/${slug}`).then((res) => res.data.data);
export const fetchPublicTestimonials = () =>
  api.get("/public/testimonials").then((res) => res.data.data);
export const submitPublicTestimonial = (values) =>
  api.post("/public/testimonials", values).then((res) => res.data);
export const fetchPublicProfile = (slug) =>
  api.get(`/public/profiles/${slug}`).then((res) => res.data.data);
export const fetchPublicApplication = () =>
  api.get("/public/application").then((res) => res.data.data);
export const submitPublicApplication = (values) =>
  api.post("/public/application", values).then((res) => res.data);
export const fetchStudentProfileEditor = (token) =>
  api.get(`/public/profile-edit/${token}`).then((res) => res.data);
export const updateStudentProfile = (token, values) =>
  api.patch(`/public/profile-edit/${token}`, values).then((res) => res.data);
export const fetchPublicManagementConfig = () =>
  api.get("/public-management/config").then((res) => res.data.data);
export const updatePublicManagementConfig = (values) =>
  api.patch("/public-management/config", values).then((res) => res.data.data);
export const loadLeadPorchStarterSite = () =>
  api
    .post("/public-management/config/lead-porch-starter")
    .then((res) => res.data.data);
export const fetchApplicationConfig = () =>
  api.get("/public-management/application-config").then((res) => res.data.data);
export const updateApplicationConfig = (values) =>
  api
    .patch("/public-management/application-config", values)
    .then((res) => res.data.data);
export const fetchManagedApplications = (params = {}) =>
  api
    .get("/public-management/applications", { params })
    .then((res) => res.data.data);
export const fetchManagedTestimonials = () =>
  api.get("/public-management/testimonials").then((res) => res.data.data);
export const createManagedTestimonial = (values) =>
  api
    .post("/public-management/testimonials", values)
    .then((res) => res.data.data);
export const updateManagedTestimonial = (id, values) =>
  api
    .patch(`/public-management/testimonials/${id}`, values)
    .then((res) => res.data.data);
export const deleteManagedTestimonial = (id) =>
  api.delete(`/public-management/testimonials/${id}`).then((res) => res.data);
export const updateProgramPublicPresentation = (id, values) =>
  api
    .patch(`/public-management/programs/${id}`, values)
    .then((res) => res.data.data);
export const uploadProgramVideo = (values) =>
  api
    .post("/public-management/program-media", values)
    .then((res) => res.data.data);
export const uploadTestimonialVideo = async (file) => {
  const signed = await api
    .post("/public-management/testimonial-media-signature")
    .then((res) => res.data.data);
  const body = new FormData();
  body.append("file", file);
  body.append("api_key", signed.apiKey);
  body.append("timestamp", String(signed.timestamp));
  body.append("folder", signed.folder);
  body.append("signature", signed.signature);
  const upload = await axios.post(
    `https://api.cloudinary.com/v1_1/${signed.cloudName}/video/upload`,
    body,
  );
  return {
    url: upload.data.secure_url,
    publicId: upload.data.public_id,
    width: upload.data.width,
    height: upload.data.height,
    duration: upload.data.duration,
  };
};
export const uploadHomepageVideo = async (file) => {
  const signed = await api
    .post("/public-management/homepage-media-signature")
    .then((res) => res.data.data);
  const body = new FormData();
  body.append("file", file);
  body.append("api_key", signed.apiKey);
  body.append("timestamp", String(signed.timestamp));
  body.append("folder", signed.folder);
  body.append("signature", signed.signature);
  const upload = await axios.post(
    `https://api.cloudinary.com/v1_1/${signed.cloudName}/video/upload`,
    body,
  );
  return {
    url: upload.data.secure_url,
    publicId: upload.data.public_id,
    width: upload.data.width,
    height: upload.data.height,
    duration: upload.data.duration,
  };
};
export const fetchWorkspaceMedia = () =>
  api.get("/social-workspace/media").then((res) => res.data);
export const fetchManagedProfiles = () =>
  api.get("/public-management/profiles").then((res) => res.data.data);
export const createManagedProfile = (values) =>
  api.post("/public-management/profiles", values).then((res) => res.data.data);
export const updateManagedProfile = (id, values) =>
  api
    .patch(`/public-management/profiles/${id}`, values)
    .then((res) => res.data.data);
export const createStudentProfileEditToken = (id) =>
  api
    .post(`/public-management/profiles/${id}/edit-token`)
    .then((res) => res.data.data);
export const fetchMyPublicProfile = () =>
  api.get("/public-management/profile/me").then((res) => res.data.data);
export const updateMyPublicProfile = (values) =>
  api.put("/public-management/profile/me", values).then((res) => res.data.data);

// ======================================
// COACHING CRM
// ======================================

export const fetchCoaches = (params = {}) =>
  api.get("/coaching/coaches", { params }).then((res) => res.data.data);
export const fetchMyCoachProfile = () =>
  api.get("/coaching/coaches/me").then((res) => res.data.data);
export const createCoachProfile = (values) =>
  api.post("/coaching/coaches", values).then((res) => res.data.data);
export const onboardCoach = (values) =>
  api.post("/coaching/coaches/onboard", values).then((res) => res.data.data);
export const updateCoachProfile = (coachId, values) =>
  api
    .patch(`/coaching/coaches/${coachId}`, values)
    .then((res) => res.data.data);
export const fetchWorkspaceInvitation = (token) =>
  api
    .get(`/auth/invitations/${encodeURIComponent(token)}`, { timeout: 15000 })
    .then((res) => res.data);
export const acceptWorkspaceInvitation = (token, values) =>
  api
    .post(`/auth/invitations/${encodeURIComponent(token)}/accept`, values)
    .then((res) => res.data);
export const fetchMyAmbassadorProfile = () =>
  api.get("/ambassadors/me").then((res) => res.data.data);
export const updateMyAmbassadorProfile = (values) =>
  api.patch("/ambassadors/me", values).then((res) => res.data.data);
export const fetchMyAmbassadorReferrals = () =>
  api.get("/ambassadors/me/referrals").then((res) => res.data.data);
export const fetchMyAmbassadorPayouts = () =>
  api.get("/ambassadors/me/payouts").then((res) => res.data.data);
export const submitMyAmbassadorReferral = (payload) =>
  api.post("/ambassadors/me/referrals", payload).then((res) => res.data.data);
export const addMyReferralFollowUpNote = (attributionId, payload) =>
  api.post(`/ambassadors/me/referrals/${attributionId}/notes`, payload).then((res) => res.data.data);
export const fileMyReferralDispute = (attributionId, reason) =>
  api.post(`/ambassadors/me/referrals/${attributionId}/dispute`, { reason }).then((res) => res.data.data);
export const fetchAmbassadors = () =>
  api.get("/ambassadors").then((res) => res.data.data);
export const fetchAmbassadorWelcomeTemplate = () =>
  api.get("/ambassadors/welcome-template").then((res) => res.data.data);
export const saveAmbassadorWelcomeTemplate = (values) =>
  api.put("/ambassadors/welcome-template", values).then((res) => res.data.data);
export const generateAmbassadorWelcomeContent = (id) =>
  api.post(`/ambassadors/${id}/welcome-content`).then((res) => res.data.data);
export const fetchAmbassadorReferrals = (id) =>
  api.get(`/ambassadors/${id}/referrals`).then((res) => res.data.data);
export const fetchAmbassadorPayouts = (id) =>
  api.get(`/ambassadors/${id}/payouts`).then((res) => res.data.data);
export const updateAmbassadorStatus = (id, status) =>
  api
    .patch(`/ambassadors/${id}/status`, { status })
    .then((res) => res.data.data);
export const updateAmbassadorProfile = (id, values) =>
  api.patch(`/ambassadors/${id}`, values).then((res) => res.data.data);
export const updateAmbassadorReferralIdentity = (id, values) =>
  api
    .patch(`/ambassadors/${id}/referral-identity`, values)
    .then((res) => res.data.data);
export const updateAmbassadorReferralState = (id, state) =>
  api
    .patch(`/ambassadors/referrals/${id}/state`, { state })
    .then((res) => res.data.data);
export const createAmbassadorPayout = (values) =>
  api.post("/ambassadors/payouts", values).then((res) => res.data.data);
export const updateAmbassadorPayoutStatus = (id, status, notes = "") =>
  api
    .patch(`/ambassadors/payouts/${id}/status`, { status, notes })
    .then((res) => res.data.data);
export const updateCoachStatus = (coachId, status) =>
  api
    .patch(`/coaching/coaches/${coachId}/status`, { status })
    .then((res) => res.data.data);

export const fetchCoachingPrograms = (params = {}) =>
  api.get("/coaching/programs", { params }).then((res) => res.data.data);
export const fetchPaymentConnection = () =>
  api.get("/payments/connection").then((res) => res.data);
export const startSquareOAuth = () =>
  api.get("/payments/square/oauth/start").then((res) => res.data);
export const refreshSquareConnection = () =>
  api.post("/payments/square/refresh").then((res) => res.data);
export const disconnectSquareConnection = () =>
  api.post("/payments/square/disconnect").then((res) => res.data);
export const fetchPaymentTransactions = (params = {}) =>
  api
    .get("/payments/transactions", { params })
    .then((res) => res.data.transactions);
export const createPaymentCheckout = (
  values,
  idempotencyKey = crypto.randomUUID(),
) =>
  api
    .post("/payments/checkout", values, {
      headers: { "Idempotency-Key": idempotencyKey },
    })
    .then((res) => res.data);
export const createApplicationPaymentRequest = (
  applicationId,
  values,
  idempotencyKey = crypto.randomUUID(),
) =>
  api
    .post(`/payments/applications/${applicationId}/payment-request`, values, {
      headers: { "Idempotency-Key": idempotencyKey },
    })
    .then((res) => res.data);
export const fetchPublicPaymentRequest = (token) =>
  api
    .get(`/payments/public/${encodeURIComponent(token)}`)
    .then((res) => res.data.request);
export const beginPublicPaymentCheckout = (token) =>
  api
    .post(`/payments/public/${encodeURIComponent(token)}/checkout`)
    .then((res) => res.data);
export const fetchPublicPaymentPlan = (token) =>
  api
    .get(`/payments/plans/public/${encodeURIComponent(token)}`)
    .then((res) => res.data.plan);
export const beginPublicInstallmentCheckout = (token, number) =>
  api
    .post(
      `/payments/plans/public/${encodeURIComponent(token)}/installments/${number}/checkout`,
    )
    .then((res) => res.data);
export const fetchPaymentPlans = () =>
  api.get("/payments/plans").then((res) => res.data.plans || []);
export const createApplicationPaymentPlan = (applicationId, values) =>
  api
    .post(`/payments/applications/${applicationId}/payment-plan`, values)
    .then((res) => res.data);
export const cancelPaymentPlan = (planId) =>
  api.post(`/payments/plans/${planId}/cancel`).then((res) => res.data.plan);
export const fetchPaymentPlanShareLink = (planId) =>
  api
    .get(`/payments/plans/${planId}/share-link`)
    .then((res) => res.data.publicPaymentPlanUrl);
export const refundPaymentTransaction = (
  id,
  values,
  idempotencyKey = crypto.randomUUID(),
) =>
  api
    .post(`/payments/transactions/${id}/refunds`, values, {
      headers: { "Idempotency-Key": idempotencyKey },
    })
    .then((res) => res.data.transaction);
export const updatePaymentSettings = (values) =>
  api.patch("/payments/settings", values).then((res) => res.data.settings);
export const createCoachingProgram = (values) =>
  api.post("/coaching/programs", values).then((res) => res.data.data);
export const updateCoachingProgram = (programId, values) =>
  api
    .patch(`/coaching/programs/${programId}`, values)
    .then((res) => res.data.data);
export const archiveCoachingProgram = (programId) =>
  api
    .post(`/coaching/programs/${programId}/archive`)
    .then((res) => res.data.data);
export const updateProgramSkoolMapping = (programId, values) =>
  api
    .patch(`/coaching/programs/${programId}/skool-mapping`, values)
    .then((res) => res.data.data);
export const fetchSkoolStatus = () =>
  api.get("/coaching/skool/status").then((res) => res.data.data);
export const configureSkool = (values) =>
  api.put("/coaching/skool/configure", values).then((res) => res.data.data);
export const requestSkoolAccess = (enrollmentId, dispatch = true) =>
  api
    .post(`/coaching/enrollments/${enrollmentId}/skool-access`, { dispatch })
    .then((res) => res.data.data);
export const fetchSkoolAccessRequests = (params = {}) =>
  api
    .get("/coaching/skool/access-requests", { params })
    .then((res) => res.data.data);
export const retrySkoolAccess = (requestId) =>
  api
    .post(`/coaching/skool/access-requests/${requestId}/retry`)
    .then((res) => res.data.data);
export const fetchSkoolPurchases = (params = {}) =>
  api.get("/coaching/skool/purchases", { params }).then((res) => res.data.data);
export const previewCommunicationSegment = (segment) =>
  api
    .post("/coaching/communications/segments/preview", { segment })
    .then((res) => res.data.data);
export const fetchCommunicationCampaigns = (params = {}) =>
  api
    .get("/coaching/communications/campaigns", { params })
    .then((res) => res.data.data);
export const createCommunicationCampaign = (values) =>
  api
    .post("/coaching/communications/campaigns", values)
    .then((res) => res.data.data);
export const previewCommunicationCampaign = (campaignId) =>
  api
    .get(`/coaching/communications/campaigns/${campaignId}/preview`)
    .then((res) => res.data.data);
export const scheduleCommunicationCampaign = (campaignId, scheduledFor) =>
  api
    .post(`/coaching/communications/campaigns/${campaignId}/schedule`, {
      scheduledFor,
    })
    .then((res) => res.data.data);
export const fetchCommunicationJobs = (params = {}) =>
  api
    .get("/coaching/communications/jobs", { params })
    .then((res) => res.data.data);
export const scheduleSessionReminders = (sessionId, values) =>
  api
    .post(`/coaching/sessions/${sessionId}/reminders`, values)
    .then((res) => res.data.data);
export const scheduleOnboardingCommunications = (enrollmentId, channels) =>
  api
    .post(`/coaching/enrollments/${enrollmentId}/onboarding-communications`, {
      channels,
    })
    .then((res) => res.data.data);

export const fetchCoachingEnrollments = (params = {}) =>
  api.get("/coaching/enrollments", { params }).then((res) => res.data.data);
export const createCoachingEnrollment = (values) =>
  api.post("/coaching/enrollments", values).then((res) => res.data.data);
export const transitionCoachingEnrollment = (enrollmentId, values) =>
  api
    .post(`/coaching/enrollments/${enrollmentId}/transition`, values)
    .then((res) => res.data.data);

export const fetchCoachAssignments = (params = {}) =>
  api.get("/coaching/assignments", { params }).then((res) => res.data.data);
export const createCoachAssignment = (values) =>
  api.post("/coaching/assignments", values).then((res) => res.data.data);
export const completeCoachAssignment = (assignmentId) =>
  api
    .post(`/coaching/assignments/${assignmentId}/complete`)
    .then((res) => res.data.data);
export const transitionCoachAssignment = (assignmentId, values) =>
  api
    .post(`/coaching/assignments/${assignmentId}/transition`, values)
    .then((res) => res.data.data);
export const fetchCoachingStudent = (contactId) =>
  api.get(`/coaching/students/${contactId}`).then((res) => res.data.data);
export const summarizeCoachingStudentWithAi = (contactId) =>
  api.post(`/coaching/students/${contactId}/ai-summary`).then((res) => res.data.data);
export const fetchCoachingSuccessPatterns = () =>
  api.get("/coaching/success-patterns").then((res) => res.data.data);
export const summarizeCoachingSuccessPatterns = () =>
  api.post("/coaching/success-patterns/summarize").then((res) => res.data.data);
export const fetchCoachingNotes = (contactId, params = {}) =>
  api
    .get(`/coaching/students/${contactId}/notes`, { params })
    .then((res) => res.data.data);
export const createCoachingNote = (contactId, values) =>
  api
    .post(`/coaching/students/${contactId}/notes`, values)
    .then((res) => res.data.data);
export const updateCoachingNote = (noteId, values) =>
  api.patch(`/coaching/notes/${noteId}`, values).then((res) => res.data.data);
export const fetchCoachingHandoffs = (contactId, params = {}) =>
  api
    .get(`/coaching/students/${contactId}/handoffs`, { params })
    .then((res) => res.data.data);
export const fetchAssignmentHandoff = (assignmentId) =>
  api
    .get(`/coaching/assignments/${assignmentId}/handoff`)
    .then((res) => res.data.data);
export const saveAssignmentHandoff = (assignmentId, values) =>
  api
    .post(`/coaching/assignments/${assignmentId}/handoff`, values)
    .then((res) => res.data.data);
export const fetchReferralIdentities = () =>
  api.get("/coaching/referral-identities").then((res) => res.data.data);
export const updateReferralIdentity = (coachId, values) =>
  api
    .patch(`/coaching/coaches/${coachId}/referral-identity`, values)
    .then((res) => res.data.data);
export const fetchCoachingReferrals = (params = {}) =>
  api.get("/coaching/referrals", { params }).then((res) => res.data.data);
export const createCoachingReferral = (values) =>
  api.post("/coaching/referrals", values).then((res) => res.data.data);
export const fetchCommissionRules = () =>
  api.get("/coaching/commission-rules").then((res) => res.data.data);
export const saveCommissionRule = (values) =>
  api.post("/coaching/commission-rules", values).then((res) => res.data.data);
export const fetchCoachingCommissions = (params = {}) =>
  api.get("/coaching/commissions", { params }).then((res) => res.data.data);
export const updateCommissionStatus = (commissionId, values) =>
  api
    .patch(`/coaching/commissions/${commissionId}/status`, values)
    .then((res) => res.data.data);
export const fetchCoachCalendarConnection = () =>
  api.get("/coaching/calendar/connection").then((res) => res.data.data);
export const beginCoachCalendarConnection = () =>
  api
    .get("/coaching/calendar/oauth/start")
    .then((res) => res.data.authorizationUrl);
export const disconnectCoachCalendar = () =>
  api.delete("/coaching/calendar/connection").then((res) => res.data.data);
export const fetchCoachCalendars = () =>
  api.get("/coaching/calendar/calendars").then((res) => res.data.data);
export const selectCoachCalendar = (values) =>
  api
    .patch("/coaching/calendar/selection", values)
    .then((res) => res.data.data);
export const fetchCoachCalendarConnections = () =>
  api.get("/coaching/calendar/connections").then((res) => res.data.data);
export const fetchCoachingSessions = (params = {}) =>
  api.get("/coaching/sessions", { params }).then((res) => res.data.data);
export const checkCoachAvailability = (values) =>
  api
    .post("/coaching/sessions/availability", values)
    .then((res) => res.data.data);
export const createCoachingSession = (values) =>
  api.post("/coaching/sessions", values).then((res) => res.data.data);
export const rescheduleCoachingSession = (sessionId, values) =>
  api
    .patch(`/coaching/sessions/${sessionId}/reschedule`, values)
    .then((res) => res.data.data);
export const cancelCoachingSession = (sessionId, values) =>
  api
    .post(`/coaching/sessions/${sessionId}/cancel`, values)
    .then((res) => res.data.data);
export const fetchCoachZoomConnection = () =>
  api.get("/coaching/zoom/connection").then((res) => res.data.data);
export const beginCoachZoomConnection = () =>
  api
    .get("/coaching/zoom/oauth/start")
    .then((res) => res.data.authorizationUrl);
export const disconnectCoachZoom = () =>
  api.delete("/coaching/zoom/connection").then((res) => res.data.data);
export const fetchCoachZoomConnections = () =>
  api.get("/coaching/zoom/connections").then((res) => res.data.data);

export const fetchDiscoveryTemplates = () =>
  api.get("/workspace/discovery-templates").then((res) => res.data);

export const saveDiscoveryTemplates = (templates) =>
  api
    .put("/workspace/discovery-templates", { templates })
    .then((res) => res.data);

// ======================================
// CAMPAIGNS
// ======================================

export const fetchCampaigns = (eventId) =>
  api
    .get("/campaigns", {
      params: eventId ? { eventId } : {},
    })
    .then((res) => res.data);

export const fetchCampaign = (campaignId) =>
  api.get(`/campaigns/${campaignId}`).then((res) => res.data);

export const previewCampaignAudience = (campaignId) =>
  api.get(`/campaigns/${campaignId}/audience-match`).then((res) => res.data);

export const assignCampaignAudience = (campaignId) =>
  api.post(`/campaigns/${campaignId}/audience-match`).then((res) => res.data);

export const updateCampaignRegistrationLinks = (campaignId, links) =>
  api
    .patch(`/campaigns/${campaignId}/registration-links`, links)
    .then((res) => res.data);

export const updateCampaignBrand = (campaignId, brand) =>
  api.patch(`/campaigns/${campaignId}/brand`, brand).then((res) => res.data);

export const updateCampaignSchedule = (campaignId, startDate) =>
  api
    .patch(`/campaigns/${campaignId}/schedule`, { startDate })
    .then((res) => res.data);

export const fetchCampaignEmailTemplate = (
  campaignId,
  audienceKey = "general",
) =>
  api
    .get(`/campaigns/${campaignId}/email-template`, { params: { audienceKey } })
    .then((res) => res.data);

export const saveCampaignEmailTemplate = (campaignId, template) =>
  api
    .put(`/campaigns/${campaignId}/email-template`, template)
    .then((res) => res.data);

export const approveCampaignEmailTemplate = (
  campaignId,
  audienceKey = "general",
) =>
  api
    .post(`/campaigns/${campaignId}/email-template/approve`, { audienceKey })
    .then((res) => res.data);

export const fetchMarketingCampaign = async (campaignId) => {
  const res = await api.get(`/marketing-campaigns/${campaignId}`);

  return res.data;
};

export const createCampaign = (campaignData) =>
  api.post("/campaigns", campaignData).then((res) => res.data);

export const fetchCampaignDeletionPreview = (campaignId) =>
  api.get(`/campaigns/${campaignId}/deletion-preview`).then((res) => res.data);

export const deleteCampaign = (campaignId, options = {}) =>
  api
    .delete(`/campaigns/${campaignId}`, { data: options })
    .then((res) => res.data);

export const createCampaignFromEvent = (eventId) =>
  api.post(`/campaigns/from-event/${eventId}`).then((res) => res.data);

// ======================================
// EVENTS
// ======================================

export const fetchEvents = () => api.get("/events").then((res) => res.data);

export const fetchEvent = (eventId) =>
  api.get(`/events/${eventId}`).then((res) => res.data);

export const createEvent = (eventData) =>
  api.post("/events", eventData).then((res) => res.data);

export const recommendEventAudience = (eventData) =>
  api
    .post("/events/audience-recommendations", eventData)
    .then((res) => res.data);

export const uploadEventImage = (imageData) =>
  api.post("/events/images", imageData).then((res) => res.data);

export const fetchImageUploadStatus = () =>
  api.get("/events/images/status").then((res) => res.data);

// ======================================
// EVENTBRITE
// ======================================

export const fetchEventbriteEvents = () =>
  api.get("/eventbrite/events").then((res) => res.data);

export const importEventbriteEvent = (eventId) =>
  api.post(`/eventbrite/import/${eventId}`).then((res) => res.data);

export const fetchEventbriteConnection = () =>
  api.get("/eventbrite/oauth/status").then((res) => res.data);

export const beginEventbriteConnection = () =>
  api.get("/eventbrite/oauth/start").then((res) => res.data);

export const disconnectEventbrite = () =>
  api.post("/eventbrite/oauth/disconnect").then((res) => res.data);

export const fetchGmailConnection = () =>
  api.get("/gmail/status").then((res) => res.data);

export const beginGmailConnection = () =>
  api.get("/gmail/oauth/start").then((res) => res.data);

export const disconnectGmail = () =>
  api.post("/gmail/disconnect").then((res) => res.data);

export const fetchGmailThreads = (q = "in:inbox") =>
  api.get("/gmail/threads", { params: { q } }).then((res) => res.data);

export const fetchGmailThread = (threadId) =>
  api.get(`/gmail/threads/${threadId}`).then((res) => res.data);

export const syncGmailConversations = (query = "in:inbox", limit = 20) =>
  api.post("/gmail/sync", { query, limit }).then((res) => res.data);

export const updateGmailThread = (threadId, action) =>
  api
    .post(`/gmail/threads/${threadId}/action`, { action })
    .then((res) => res.data);

export const emptyGmailTrash = () =>
  api
    .delete("/gmail/trash", { data: { confirmation: "DELETE ALL TRASH" } })
    .then((res) => res.data);

export const deleteSelectedGmailTrash = (threadIds) =>
  api
    .post("/gmail/trash/delete-selected", {
      threadIds,
      confirmation: "DELETE SELECTED",
    })
    .then((res) => res.data);

export const sendGmailMessage = (message) =>
  api.post("/gmail/send", message).then((res) => res.data);

export const syncGmailOutreachReplies = () =>
  api.post("/gmail/sync-outreach-replies").then((res) => res.data);

export const fetchContactEmailHistory = (email) =>
  api
    .get("/gmail/contact-history", { params: { email } })
    .then((res) => res.data);

export const fetchOutreachEmailHistory = (page = 1, limit = 50) =>
  api
    .get("/gmail/outreach-history", { params: { page, limit } })
    .then((res) => res.data);

export const syncEventbriteEvent = (eventId) =>
  api.post(`/eventbrite/events/${eventId}/sync`).then((res) => res.data);

export const fetchEventbriteWebhookStatus = () =>
  api.get("/eventbrite/webhook/status").then((res) => res.data);

export const configureEventbriteWebhook = () =>
  api.post("/eventbrite/webhook/configure").then((res) => res.data);

export const createManagedEventbriteEvent = (data) =>
  api.post("/eventbrite/managed-events", data).then((res) => res.data);

export const createEventbriteDraft = (eventId) =>
  api
    .post(`/eventbrite/managed-events/${eventId}/create-draft`)
    .then((res) => res.data);

export const updateManagedEventbriteEvent = (eventId, data) =>
  api
    .patch(`/eventbrite/managed-events/${eventId}`, data)
    .then((res) => res.data);

export const publishManagedEventbriteEvent = (eventId) =>
  api
    .post(`/eventbrite/managed-events/${eventId}/publish`)
    .then((res) => res.data);

// ======================================
// LEAD GENERATION
// ======================================

export const generateLeads = (campaignId) =>
  api
    .post("/outreach/leads", {
      campaignId,
    })
    .then((res) => res.data);

// ======================================
// OUTREACH
// ======================================

export const fetchOutreach = (campaignId) =>
  api
    .get("/outreach", {
      params: {
        campaignId,
      },
    })
    .then((res) => res.data);

export const fetchOutreachAnalytics = () =>
  api.get("/outreach/analytics/summary").then((res) => res.data);

export const fetchOutreachPreview = (outreachId) =>
  api.get(`/outreach/${outreachId}/preview`).then((res) => res.data);

export const sendOutreachTestEmail = (outreachId) =>
  api.post(`/outreach/${outreachId}/test`).then((res) => res.data);

export const fetchContacts = (params = {}) =>
  api.get("/contacts", { params }).then((res) => res.data);

export const fetchContact = (contactId) =>
  api.get(`/contacts/${contactId}`).then((res) => res.data);

export const fetchContactOverview = () =>
  api.get("/contacts/overview").then((res) => res.data);

export const fetchCompanies = (params = {}) =>
  api.get("/organizations", { params }).then((res) => res.data);

export const fetchCompany = (companyId) =>
  api.get(`/organizations/${companyId}`).then((res) => res.data);

export const canonicalizeContactCompanies = (apply = false) =>
  api
    .post("/organizations/canonicalize-contacts", { apply })
    .then((res) => res.data);

export const fetchConversationMailboxes = () =>
  api.get("/conversations/mailboxes").then((res) => res.data);

export const updateConversationMailbox = (mailboxId, payload) =>
  api
    .patch(`/conversations/mailboxes/${mailboxId}`, payload)
    .then((res) => res.data);

export const saveConversationDraft = (threadId, payload) =>
  api.put(`/conversations/${threadId}/draft`, payload).then((res) => res.data);

export const fetchCrmActivities = (params = {}) =>
  api.get("/activities", { params }).then((res) => res.data);

export const createCrmActivity = (payload) =>
  api.post("/activities", payload).then((res) => res.data);

export const fetchTasks = (completed = false) =>
  api
    .get("/activities/tasks", { params: { completed } })
    .then((res) => res.data);

export const completeTask = (origin, taskId) =>
  api
    .patch(`/activities/tasks/${origin}/${taskId}/complete`)
    .then((res) => res.data);

export const fetchOpportunities = (params = {}) =>
  api.get("/opportunities", { params }).then((res) => res.data);

export const createOpportunity = (payload) =>
  api.post("/opportunities", payload).then((res) => res.data);

export const updateOpportunity = (opportunityId, payload) =>
  api.patch(`/opportunities/${opportunityId}`, payload).then((res) => res.data);

export const savePipelineStages = (stages) =>
  api.put("/opportunities/stages", { stages }).then((res) => res.data);
export const fetchCloserQueue = (params = {}) =>
  api.get("/opportunities/closer-queue", { params }).then((res) => res.data);
export const assignCloser = (opportunityId, payload) =>
  api
    .post(`/opportunities/${opportunityId}/assign`, payload)
    .then((res) => res.data);
export const recordCloserActivity = (opportunityId, payload) =>
  api
    .post(`/opportunities/${opportunityId}/activities`, payload)
    .then((res) => res.data);
export const requestSalesAssist = (opportunityId, payload) =>
  api
    .post(`/opportunities/${opportunityId}/sales-assist`, payload)
    .then((res) => res.data);
export const fetchLeadWorkflowAnalytics = () =>
  api.get("/opportunities/lead-workflow/analytics").then((res) => res.data);
export const prepareCoachingHandoff = (opportunityId) =>
  api
    .post(`/opportunities/${opportunityId}/coaching-handoff/prepare`)
    .then((res) => res.data);
export const fetchConnectionPriorities = (campaignId) =>
  api
    .get("/contacts/priorities/ranked", { params: { campaignId } })
    .then((res) => res.data);

export const fetchIntegrationHub = () =>
  api.get("/integrations/hub").then((res) => res.data);

export const createAudienceDefinition = (payload) =>
  api.post("/audience", payload).then((res) => res.data);

export const createMarketResearchPlan = (question) =>
  api.post("/audience/research/plan", { question }).then((res) => res.data);

export const fetchMarketResearchResults = (audienceId) =>
  api.get(`/audience/research/results/${audienceId}`).then((res) => res.data);

export const fetchMarketResearchSources = () =>
  api.get("/audience/research/sources").then((res) => res.data);

export const fetchResearchMonitors = () =>
  api.get("/audience/research/monitors").then((res) => res.data);

export const fetchResearchMonitorPresets = () =>
  api.get("/audience/research/monitor-presets").then((res) => res.data);

export const fetchResearchActivity = (params = {}) =>
  api.get("/audience/research/activity", { params }).then((res) => res.data);

export const fetchResearchNotifications = () =>
  api.get("/audience/research/notifications").then((res) => res.data);

export const updateResearchNotification = (notificationId, read = true) =>
  api
    .patch(`/audience/research/notifications/${notificationId}`, { read })
    .then((res) => res.data);

export const clearResearchNotifications = () =>
  api.delete("/audience/research/notifications").then((res) => res.data);

export const createResearchMonitor = (payload) =>
  api.post("/audience/research/monitors", payload).then((res) => res.data);

export const updateResearchMonitor = (monitorId, payload) =>
  api
    .patch(`/audience/research/monitors/${monitorId}`, payload)
    .then((res) => res.data);

export const deleteResearchMonitor = (monitorId) =>
  api
    .delete(`/audience/research/monitors/${monitorId}`)
    .then((res) => res.data);

export const runResearchMonitor = (monitorId) =>
  api
    .post(`/audience/research/monitors/${monitorId}/run`)
    .then((res) => res.data);

export const fetchIntentSignals = (params = {}) =>
  api.get("/audience/research/signals", { params }).then((res) => res.data);

export const summarizeWeeklyDiscoveryFindings = (days) =>
  api.post("/audience/research/weekly-brief", { days }).then((res) => res.data);

export const fetchMonitorPerformance = () =>
  api.get("/audience/research/monitor-performance").then((res) => res.data);

export const fetchDiscoveryStrategyRecommendations = () =>
  api.post("/audience/research/strategy-recommendations").then((res) => res.data);

export const updateIntentSignal = (signalId, status) =>
  api
    .patch(`/audience/research/signals/${signalId}`, { status })
    .then((res) => res.data);

// Explicit, persistent "Move to Live Leads" / "Not a fit" / "Restore"
// override — always wins over the automatic Watchlist/Rejected/Community
// classification on every future load. Pass bucket: null to restore
// automatic classification.
export const moveIntentSignal = (signalId, bucket) =>
  api.post(`/audience/research/signals/${signalId}/move`, { bucket }).then((res) => res.data);

export const researchIntentSignalIdentity = (signalId, payload = {}) =>
  api
    .post(`/audience/research/signals/${signalId}/identity-research`, payload)
    .then((res) => res.data);

export const convertIntentSignal = (signalId, payload = {}) =>
  api
    .post(`/audience/research/signals/${signalId}/convert`, payload)
    .then((res) => res.data);

export const generateBiggerPocketsPublicResponse = (signalId, draft) =>
  api
    .post(
      `/audience/research/signals/${signalId}/public-response-draft`,
      draft === undefined ? {} : { draft },
    )
    .then((res) => res.data);

export const generateIntentEmailDraft = (signalId, campaignId) =>
  api
    .post(`/audience/research/signals/${signalId}/email-drafts`, { campaignId })
    .then((res) => res.data);

export const updateIntentEmailDraft = (signalId, draftId, payload) =>
  api
    .patch(
      `/audience/research/signals/${signalId}/email-drafts/${draftId}`,
      payload,
    )
    .then((res) => res.data);

export const transferIntentEmailDraft = (signalId, draftId) =>
  api
    .post(
      `/audience/research/signals/${signalId}/email-drafts/${draftId}/transfer`,
    )
    .then((res) => res.data);

export const fetchMarketResearchHistory = (limit = 30) =>
  api
    .get("/audience/research/history", { params: { limit } })
    .then((res) => res.data);

export const fetchPeopleResearchPreviews = (limit = 20) =>
  api
    .get("/audience/research/people-previews", { params: { limit } })
    .then((res) => res.data);

// Vertex AI Grounding — optional public-web research source for Discovery.
// Its own longer timeout, same reasoning as runVertexGrounding: not a
// change to the shared client's default.
export const runVertexGroundingDiscoverySearch = (payload) =>
  api.post("/audience/research/vertex-grounding/search", payload, { timeout: 90000 }).then((res) => res.data);
export const fetchVertexGroundingResults = (params = {}) =>
  api.get("/audience/research/vertex-grounding/results", { params }).then((res) => res.data);
export const fetchSuggestedGroundingSearches = () =>
  api.get("/audience/research/vertex-grounding/suggested-searches").then((res) => res.data);
export const saveVertexGroundingResult = (id) =>
  api.post(`/audience/research/vertex-grounding/results/${id}/save`).then((res) => res.data);
export const dismissVertexGroundingResult = (id) =>
  api.post(`/audience/research/vertex-grounding/results/${id}/dismiss`).then((res) => res.data);
export const enrichVertexGroundingResultWithPdl = (id) =>
  api.post(`/audience/research/vertex-grounding/results/${id}/enrich-pdl`).then((res) => res.data);
export const rankVertexGroundingResultsForProgramFit = (resultIds) =>
  api.post("/audience/research/vertex-grounding/results/rank", { resultIds }, { timeout: 60000 }).then((res) => res.data);

// Jarvis-coordinated, multi-provider lead generation (Vertex/OpenAI/PDL
// Person Search/Apollo People Search). Listing/saving/dismissing/PDL-
// enriching a result stays on the existing vertex-grounding endpoints
// above — PDL/Apollo-sourced rows land in that same review queue.
export const fetchLeadGenerationProviderAvailability = () =>
  api.get("/lead-generation/provider-availability").then((res) => res.data);
export const fetchLeadGenerationPrograms = () =>
  api.get("/lead-generation/programs").then((res) => res.data);
export const fetchLeadGenerationProgramSearchSuggestions = (noteId) =>
  api.get(`/lead-generation/programs/${noteId}/search-suggestions`).then((res) => res.data);
export const proposeLeadGenerationSearch = (payload) =>
  api.post("/lead-generation/searches/propose", payload, { timeout: 60000 }).then((res) => res.data);
export const approveLeadGenerationSearch = (searchId, overrides = {}) =>
  api.post(`/lead-generation/searches/${searchId}/approve`, overrides, { timeout: 90000 }).then((res) => res.data);
export const fetchLeadGenerationSearch = (searchId) =>
  api.get(`/lead-generation/searches/${searchId}`).then((res) => res.data);
export const enrichVertexGroundingResultWithApollo = (id) =>
  api.post(`/lead-generation/results/${id}/enrich-apollo`).then((res) => res.data);
export const qualifyLeadGenerationResults = (resultIds) =>
  api.post("/lead-generation/results/qualify", { resultIds }, { timeout: 60000 }).then((res) => res.data);
export const proposeLeadGenerationMonitor = (searchId) =>
  api.post(`/lead-generation/searches/${searchId}/propose-monitor`).then((res) => res.data);
export const fetchLeadGenerationMonitorSuggestions = () =>
  api.get("/lead-generation/monitor-suggestions").then((res) => res.data);

// High-volume Public Web Discovery engine (services/publicWebDiscoveryEngineService.js):
// many editable search-family queries per approved program, run through a
// queued/checkpointed worker, crawled citations, PDL cross-reference,
// freshness tiers, hard spending caps, and an owner-controlled scheduler.
// Every accepted candidate lands in the SAME GroundingResearchResult review
// queue the endpoints above already read/write — nothing new to fetch there.
export const proposePublicWebDiscoveryRun = (payload) =>
  api.post("/public-web-discovery/runs/propose", payload, { timeout: 60000 }).then((res) => res.data);
// One-click "Find prospective students" preset: PDL (independent
// candidate source) → intent discussions → aspiring/beginner people →
// communities/groups, with conservative first-run defaults already set.
export const proposeStudentSearchPreset = (payload) =>
  api.post("/public-web-discovery/runs/propose-student-preset", payload, { timeout: 60000 }).then((res) => res.data);
export const fetchPublicWebDiscoveryRun = (runId) =>
  api.get(`/public-web-discovery/runs/${runId}`).then((res) => res.data);
export const fetchPublicWebDiscoveryRuns = () =>
  api.get("/public-web-discovery/runs").then((res) => res.data);
export const approvePublicWebDiscoveryRun = (runId, overrides = {}) =>
  api.post(`/public-web-discovery/runs/${runId}/approve`, overrides).then((res) => res.data);
// Free, pure preview of the EXACT finalized (round-robined, query-limit
// sliced) job plan approving with these settings would produce — never
// estimate from the unsliced draft query collection in the UI itself.
export const previewPublicWebDiscoveryRunPlan = (payload) =>
  api.post("/public-web-discovery/runs/preview", payload).then((res) => res.data);
// A single Vertex grounded-search call is allowed up to 75s server-side
// (services/vertexGroundingService.js's GROUNDING_TIMEOUT_MS — a real
// grounded search legitimately takes that long), plus per-result citation
// crawling on top of that. The previous 60s client timeout was SHORTER
// than that single-call ceiling, so the browser gave up before the
// backend's own, deliberately generous timeout ever could — the backend
// kept working and genuinely completing/saving each tick a little later,
// which is why it looked like a silent, unexplained failure with nothing
// wrong to find in server logs. 150s gives real headroom above the
// worst realistic case for one batch step.
export const processPublicWebDiscoveryRunBatch = (runId, batchSize) =>
  api.post(`/public-web-discovery/runs/${runId}/process-next-batch`, { batchSize }, { timeout: 150000 }).then((res) => res.data);
export const pausePublicWebDiscoveryRun = (runId) =>
  api.post(`/public-web-discovery/runs/${runId}/pause`).then((res) => res.data);
export const resumePublicWebDiscoveryRun = (runId) =>
  api.post(`/public-web-discovery/runs/${runId}/resume`).then((res) => res.data);
export const cancelPublicWebDiscoveryRun = (runId) =>
  api.post(`/public-web-discovery/runs/${runId}/cancel`).then((res) => res.data);
export const createDiscoverySchedule = (payload) =>
  api.post("/public-web-discovery/schedules", payload).then((res) => res.data);
export const fetchDiscoverySchedules = () =>
  api.get("/public-web-discovery/schedules").then((res) => res.data);
export const enableDiscoverySchedule = (scheduleId) =>
  api.post(`/public-web-discovery/schedules/${scheduleId}/enable`).then((res) => res.data);
export const disableDiscoverySchedule = (scheduleId) =>
  api.post(`/public-web-discovery/schedules/${scheduleId}/disable`).then((res) => res.data);
export const runDiscoveryScheduleNow = (scheduleId) =>
  api.post(`/public-web-discovery/schedules/${scheduleId}/run-now`).then((res) => res.data);

export const startExternalMarketResearch = (payload) =>
  api.post("/audience/research/run", payload).then((res) => res.data);

export const fetchMarketResearchJob = (jobId) =>
  api.get(`/audience/research/jobs/${jobId}`).then((res) => res.data);

export const discoverAudienceOrganizations = (audienceId) =>
  api.post(`/audience/${audienceId}/discover`).then((res) => res.data);

export const previewOrganizationImport = (rows) =>
  api
    .post("/audience/imports/organizations/preview", { rows })
    .then((res) => res.data);

export const importOrganizations = (rows, name) =>
  api
    .post("/audience/imports/organizations", { rows, name })
    .then((res) => res.data);

export const ingestContacts = (payload) =>
  api.post("/contacts/ingest", payload).then((res) => res.data);

export const previewContactIngestion = (payload) =>
  api.post("/contacts/ingest/preview", payload).then((res) => res.data);

export const fetchLatestContactImport = () =>
  api.get("/contacts/imports/latest").then((res) => res.data);

export const createEmailVerificationBatch = (emails) =>
  api
    .post("/contacts/email-verification/batches", { emails })
    .then((res) => res.data);

export const fetchEmailVerificationBatch = (batchId) =>
  api
    .get(`/contacts/email-verification/batches/${batchId}`)
    .then((res) => res.data);

export const recoverEmailVerificationBatch = (emails) =>
  api
    .post("/contacts/email-verification/batches/recover", { emails })
    .then((res) => res.data);

export const assessEmailRisk = (emails) =>
  api.post("/contacts/email-risk/check", { emails }).then((res) => res.data);

export const fetchMcpAccessTokens = () =>
  api.get("/mcp-access-tokens").then((res) => res.data);

export const createMcpAccessToken = (name, expiresInDays = 90) =>
  api
    .post("/mcp-access-tokens", { name, expiresInDays })
    .then((res) => res.data);

export const revokeMcpAccessToken = (id) =>
  api.delete(`/mcp-access-tokens/${id}`).then((res) => res.data);

export const archiveContact = (contactId) =>
  api.post(`/contacts/${contactId}/archive`).then((res) => res.data);
export const deleteContact = (contactId, confirmCascade = false) =>
  api
    .delete(`/contacts/${contactId}`, { data: { confirmCascade } })
    .then((res) => res.data);
export const mergeContacts = (keepId, mergeId) =>
  api.post("/contacts/merge", { keepId, mergeId }).then((res) => res.data);
export const updateContact = (contactId, data) =>
  api.patch(`/contacts/${contactId}`, data).then((res) => res.data);
export const generateLinkedinContactDraft = (contactId, tone = "warm_direct") =>
  api
    .post(`/contacts/${contactId}/linkedin-draft`, { tone })
    .then((res) => res.data);
export const updateLinkedinContactOutreach = (contactId, data) =>
  api
    .patch(`/contacts/${contactId}/linkedin-outreach`, data)
    .then((res) => res.data);
export const researchContactWithAi = (contactId) =>
  api.post(`/contacts/${contactId}/ai-research`).then((res) => res.data.data);
export const fetchPipelineHealth = () =>
  api.get("/system-agent/pipeline-health").then((res) => res.data.data);
export const synthesizePipelineHealth = () =>
  api.post("/system-agent/pipeline-health/synthesize").then((res) => res.data.data);
export const extractBusinessCard = (image) =>
  api
    .post("/contacts/business-card/extract", { image })
    .then((res) => res.data);
export const resolveDigitalBusinessCard = (url) =>
  api.post("/contacts/business-card/resolve", { url }).then((res) => res.data);
export const bulkAssignContactsToCampaign = (contactIds, campaignId) =>
  api
    .patch("/contacts/bulk/assign-campaign", { contactIds, campaignId })
    .then((res) => res.data);
export const bulkConfirmAndAssignContacts = (contactIds, campaignId) =>
  api
    .patch("/contacts/bulk/confirm-and-assign", {
      contactIds,
      campaignId,
      emailAttested: true,
      fitAttested: true,
    })
    .then((res) => res.data);

export const fetchPartners = () => api.get("/partners").then((res) => res.data);
export const createPartner = (data) =>
  api.post("/partners", data).then((res) => res.data);
export const updatePartner = (partnerId, data) =>
  api.patch(`/partners/${partnerId}`, data).then((res) => res.data);
export const createEventbriteAffiliateLink = (data) =>
  api.post("/partners/eventbrite-links", data).then((res) => res.data);
export const syncEventbriteAffiliate = (partnerId) =>
  api
    .post(`/partners/eventbrite-links/${partnerId}/sync`)
    .then((res) => res.data);
export const verifyEventbriteAffiliate = (partnerId) =>
  api
    .post(`/partners/eventbrite-links/${partnerId}/verify`)
    .then((res) => res.data);
export const fetchEventbriteAffiliateSales = (limit = 25) =>
  api
    .get("/partners/eventbrite-sales", { params: { limit } })
    .then((res) => res.data);
export const linkExistingEventbriteAffiliate = (partnerId, data) =>
  api
    .patch(`/partners/eventbrite-links/${partnerId}/link-existing`, data)
    .then((res) => res.data);

export const fetchContentBriefs = (type) =>
  api.get("/content", { params: type ? { type } : {} }).then((res) => res.data);
export const createContentBrief = (data) =>
  api.post("/content", data).then((res) => res.data);
export const updateContentBrief = (id, data) =>
  api.patch(`/content/${id}`, data).then((res) => res.data);
export const fetchSocialPublishingCapabilities = () =>
  api.get("/content/social/capabilities").then((res) => res.data.data);
export const requestSocialApproval = (id) =>
  api.post(`/content/${id}/request-approval`).then((res) => res.data.data);
export const approveSocialContent = (id) =>
  api.post(`/content/${id}/approve`).then((res) => res.data.data);
export const rejectSocialContent = (id, reason) =>
  api.post(`/content/${id}/reject`, { reason }).then((res) => res.data.data);
export const scheduleSocialContent = (id, publishAt) =>
  api
    .post(`/content/${id}/schedule`, { publishAt })
    .then((res) => res.data.data);
export const publishSocialContentNow = (id) =>
  api.post(`/content/${id}/publish-now`).then((res) => res.data.data);
export const cancelSocialContent = (id) =>
  api.post(`/content/${id}/cancel`).then((res) => res.data.data);
export const retrySocialContent = (id) =>
  api.post(`/content/${id}/retry`).then((res) => res.data.data);
export const duplicateSocialContent = (id) =>
  api.post(`/content/${id}/duplicate`).then((res) => res.data.data);
export const deleteSocialContent = (id) =>
  api.delete(`/content/${id}`).then((res) => res.data);

export const generateOutreach = (campaignId, onlyMissing = false) =>
  api
    .post("/outreach/generate", {
      campaignId,
      onlyMissing,
    })
    .then((res) => res.data);

export const updateOutreach = (id, updateData) =>
  api.patch(`/outreach/${id}`, updateData).then((res) => res.data);

export const replaceBouncedOutreachEmail = (
  id,
  email,
  confirmDirectSource = false,
) =>
  api
    .post(`/outreach/${id}/replace-email`, { email, confirmDirectSource })
    .then((res) => res.data);

export const approveAllOutreach = (campaignId) =>
  api.patch("/outreach/bulk/approve", { campaignId }).then((res) => res.data);

export const deletePendingOutreach = (campaignId) =>
  api
    .delete("/outreach/bulk/pending", { data: { campaignId } })
    .then((res) => res.data);

export const recordCampaignConsent = (campaignId, details) =>
  api
    .post("/outreach/record-consent", { campaignId, ...details })
    .then((res) => res.data);

export const previewCampaignEmailTemplate = (campaignId, template) =>
  api
    .post(`/campaigns/${campaignId}/email-template/preview`, template)
    .then((res) => res.data);

// ======================================
// EMAILS / OUTREACH SEND
// ======================================

export const sendEmails = (outreachIds) =>
  api
    .post("/outreach/send", {
      outreachIds,
    })
    .then((res) => res.data);

// ======================================
// JARVIS ASSISTANT
// ======================================

export const jarvisChat = (message) =>
  api
    .post("/jarvis/chat", {
      message,
    })
    .then((res) => res.data);

// Real OpenAI image generation via Jarvis — same underlying generator as
// generateContentImage below, just reached from the conversation.
export const jarvisGenerateImage = (prompt, options = {}) =>
  api.post("/jarvis/generate-image", { prompt, ...options }, { timeout: 90000 }).then((res) => res.data);

export const buildJarvisCampaignPackage = (packageId) =>
  api.post(`/jarvis/campaign-packages/${packageId}/build`, {}, { timeout: 120000 }).then((res) => res.data);

export const fetchJarvisCampaignPackages = (limit = 20) =>
  api.get("/jarvis/campaign-packages", { params: { limit } }).then((res) => res.data);

export const prepareJarvisMorningLeads = (values) =>
  api.post("/jarvis/morning-leads/prepare", values).then((res) => res.data);

export const fetchJarvisMorningLeadStatus = () =>
  api.get("/jarvis/morning-leads/status").then((res) => res.data.data);

export const jarvisSummary = () =>
  api.get("/jarvis/summary").then((res) => res.data);

export const jarvisStatus = () =>
  api.get("/jarvis/status").then((res) => res.data);

export const fetchJarvisProfile = () =>
  api.get("/jarvis/profile").then((res) => res.data);

export const updateJarvisProfile = (profile) =>
  api.put("/jarvis/profile", profile).then((res) => res.data);

export const prepareJarvisResearchImport = (previewId, selectedIndexes) =>
  api
    .post(`/jarvis/research-previews/${previewId}/prepare-import`, {
      selectedIndexes,
    })
    .then((res) => res.data);

export const confirmJarvisResearchImport = (
  previewId,
  approvalId,
  confirmation,
) =>
  api
    .post(`/jarvis/research-previews/${previewId}/confirm-import`, {
      approvalId,
      confirmation,
    })
    .then((res) => res.data);

export const fetchJarvisEditableContactFields = () =>
  api.get("/jarvis/contact-field-updates/fields").then((res) => res.data);

export const prepareJarvisContactFieldUpdate = (contactIds, fieldKey, value) =>
  api
    .post("/jarvis/contact-field-updates/prepare", {
      contactIds,
      fieldKey,
      value,
    })
    .then((res) => res.data);

export const confirmJarvisContactFieldUpdate = (approvalId, confirmation) =>
  api
    .post("/jarvis/contact-field-updates/confirm", { approvalId, confirmation })
    .then((res) => res.data);

export const synthesizeJarvisSpeech = (text, voice) =>
  api
    .post("/jarvis/voice/speech", { text, voice }, { responseType: "blob" })
    .then((res) => res.data);

export const jarvisRecommendCampaign = (options) =>
  api
    .post("/jarvis/actions/recommend-campaign", options)
    .then((res) => res.data);

export const jarvisPrepareRecipients = (campaignId, filters) =>
  api
    .post("/jarvis/actions/prepare-recipients", {
      campaignId,
      ...filters,
    })
    .then((res) => res.data);

export const jarvisSendTestEmail = (campaignId, testEmail) =>
  api
    .post("/jarvis/actions/send-test-email", {
      campaignId,
      testEmail,
    })
    .then((res) => res.data);

export const jarvisCampaignStatus = (campaignId) =>
  api
    .get(`/jarvis/actions/campaign-status/${campaignId}`)
    .then((res) => res.data);

export const fetchDevelopmentRequests = (secret) =>
  api
    .get("/development-requests", {
      headers: { "x-development-approval-secret": secret },
    })
    .then((res) => res.data);

export const approveDevelopmentRequest = (id, secret, note = "") =>
  api
    .patch(
      `/development-requests/${id}/approve`,
      { note },
      { headers: { "x-development-approval-secret": secret } },
    )
    .then((res) => res.data);

export const rejectDevelopmentRequest = (id, secret, note = "") =>
  api
    .patch(
      `/development-requests/${id}/reject`,
      { note },
      { headers: { "x-development-approval-secret": secret } },
    )
    .then((res) => res.data);

// ======================================
// AI GROWTH OPERATOR
// ======================================

export const getGrowthOperatorHistory = (operatorId) =>
  api
    .get(`/growth-operators/${operatorId}/actions/history`)
    .then((res) => res.data.data.history);

export const getGrowthOperatorActions = (operatorId) =>
  api
    .get(`/growth-operators/${operatorId}/actions`)
    .then((res) => res.data.data.actions);

export const fetchMarketingFeed = () =>
  api.get("/growth-operators/marketing/feed").then((res) => res.data.data);

export const executeGrowthOperatorAction = (operatorId, opportunityId) =>
  api
    .post(`/growth-operators/${operatorId}/actions/${opportunityId}/execute`)
    .then((res) => res.data);

// AI & Acquisition Controls (owner/admin only; some also require platform owner)
export const fetchAiConfig = () => api.get("/ai/config").then((res) => res.data);
export const updateAiConfig = (payload) =>
  api.patch("/ai/config", payload).then((res) => res.data);
export const fetchAiUsageSummary = () =>
  api.get("/ai/usage/summary").then((res) => res.data);
export const fetchGeminiConfig = () =>
  api.get("/ai/gemini/config").then((res) => res.data);
export const updateGeminiConfig = (payload) =>
  api.patch("/ai/gemini/config", payload).then((res) => res.data);
export const fetchProvidersHealth = () =>
  api.get("/ai/providers/health").then((res) => res.data);
export const pauseAllAiAndAcquisition = () =>
  api.post("/ai/pause-all").then((res) => res.data);
export const fetchPlatformProviderAvailability = () =>
  api.get("/platform/providers").then((res) => res.data);
export const updatePlatformProviderAvailability = (payload) =>
  api.patch("/platform/providers", payload).then((res) => res.data);
export const fetchVertexConfig = () =>
  api.get("/ai/vertex/config").then((res) => res.data);
export const updateVertexConfig = (payload) =>
  api.patch("/ai/vertex/config", payload).then((res) => res.data);
// Grounding-specific timeout, longer than the (unset, no-timeout) default
// api client — Vertex + Google Search grounding legitimately takes longer
// than a typical request; the backend's own outbound call is capped at 75s
// (services/vertexGroundingService.js), so 90s here leaves room for the
// backend's own clear, sanitized timeout error to surface first.
export const runVertexGrounding = (payload) =>
  api.post("/ai/vertex/grounding", payload, { timeout: 90000 }).then((res) => res.data);
export const runVertexAgentSearch = (payload) =>
  api.post("/ai/vertex/agent-search", payload).then((res) => res.data);
export const purgeVertexAgentSearchIndex = () =>
  api.post("/ai/vertex/agent-search/purge").then((res) => res.data);

// Knowledge Center
export const fetchKnowledgeNotes = (params = {}) =>
  api.get("/jarvis/memory/notes", { params }).then((res) => res.data);
export const fetchKnowledgeNote = (id) =>
  api.get(`/jarvis/memory/notes/${id}`).then((res) => res.data);
export const approveKnowledgeNote = (id, payload = {}) =>
  api.post(`/jarvis/memory/notes/${id}/approve`, payload).then((res) => res.data);
export const rejectKnowledgeNote = (id, reason) =>
  api.post(`/jarvis/memory/notes/${id}/reject`, { reason }).then((res) => res.data);
export const archiveKnowledgeNote = (id) =>
  api.post(`/jarvis/memory/notes/${id}/archive`).then((res) => res.data);
export const deleteKnowledgeNote = (id) =>
  api.delete(`/jarvis/memory/notes/${id}`).then((res) => res.data);
export const restoreKnowledgeNoteVersion = (id, version) =>
  api.post(`/jarvis/memory/notes/${id}/restore-version`, { version }).then((res) => res.data);
export const prepareKnowledgeMemory = (payload) =>
  api.post("/jarvis/memory/prepare", payload).then((res) => res.data);
export const confirmKnowledgeMemory = (approvalId, confirmationPhrase) =>
  api.post(`/jarvis/memory/${approvalId}/confirm`, { confirmationPhrase }).then((res) => res.data);
// Multiple PDFs, plus AI analysis, can genuinely take a while — a
// dedicated, longer per-call timeout, not a change to the shared client's
// default (matching the same reasoning as runVertexGrounding above).
export const uploadKnowledgePdfs = (files, category) => {
  const formData = new FormData();
  for (const file of files) formData.append("files", file);
  formData.append("category", category);
  return api.post("/jarvis/memory/notes/upload-pdfs", formData, { timeout: 120000 }).then((res) => res.data);
};
export const fetchVaultCredentials = () =>
  api.get("/jarvis/memory/vault-credentials").then((res) => res.data);
export const createVaultCredential = (label) =>
  api.post("/jarvis/memory/vault-credentials", { label }).then((res) => res.data);
export const revokeVaultCredential = (id) =>
  api.delete(`/jarvis/memory/vault-credentials/${id}`).then((res) => res.data);

// Ambassador Resource Center
export const fetchAmbassadorResourcesAdmin = (params = {}) =>
  api.get("/ambassadors/resources", { params }).then((res) => res.data);
export const createAmbassadorResource = (payload) =>
  api.post("/ambassadors/resources", payload).then((res) => res.data);
export const updateAmbassadorResource = (id, changes) =>
  api.patch(`/ambassadors/resources/${id}`, changes).then((res) => res.data);
export const addAmbassadorResourceVersion = (id, payload) =>
  api.post(`/ambassadors/resources/${id}/versions`, payload).then((res) => res.data);
export const setAmbassadorResourceJarvisApproval = (id, approved) =>
  api.patch(`/ambassadors/resources/${id}/jarvis-approval`, { approved }).then((res) => res.data);
export const archiveAmbassadorResource = (id) =>
  api.post(`/ambassadors/resources/${id}/archive`).then((res) => res.data);
export const fetchAmbassadorResourceHistory = (id) =>
  api.get(`/ambassadors/resources/${id}/history`).then((res) => res.data);
export const fetchMyAmbassadorResources = (search = "") =>
  api.get("/ambassadors/me/resources", { params: { search } }).then((res) => res.data);
export const downloadMyAmbassadorResource = (id) =>
  api.post(`/ambassadors/me/resources/${id}/download`, null, { responseType: "blob" });
export const acknowledgeMyAmbassadorResource = (id) =>
  api.post(`/ambassadors/me/resources/${id}/acknowledge`).then((res) => res.data);

// Audit log
export const fetchAuditLog = (params = {}) =>
  api.get("/audit", { params }).then((res) => res.data.data);
export const getAuditLogExportUrl = () => `${api.defaults.baseURL}/audit/export`;

export default api;
