// Auth0 post-login Action: profile claims for agent APIs (Actions > Library > Build Custom).
const NS = "https://fintech.example/";

exports.onExecutePostLogin = async (event, api) => {
  if (!event.user.email || !event.user.email_verified) {
    api.access.deny("a verified email address is required");
    return;
  }
  let userId = event.user.app_metadata?.user_id;
  if (!userId) {
    userId = `usr_${require("crypto").randomUUID().replaceAll("-", "")}`;
    api.user.setAppMetadata("user_id", userId); // minted once; survives email and name changes
  }
  api.accessToken.setCustomClaim(`${NS}user_id`, userId);
  api.accessToken.setCustomClaim(`${NS}email`, event.user.email);
  if (event.user.given_name) api.accessToken.setCustomClaim(`${NS}given_name`, event.user.given_name);
  if (event.user.family_name) api.accessToken.setCustomClaim(`${NS}family_name`, event.user.family_name);
};
