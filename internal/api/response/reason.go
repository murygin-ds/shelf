package response

import "github.com/gin-gonic/gin"

// ReasonKey is the details entry naming the machine-readable cause behind a code. The nine
// codes are too coarse for a client that has to say something specific — "validation_error"
// covers both a folder tree that grew too deep and a note declaring too many links.
//
// It cannot collide with the field names FailValidation writes: those come from
// validator.FieldError.Field(), which is the exported Go field name and therefore always
// starts with a capital letter, while every reason here is lower case.
const ReasonKey = "reason"

// Reasons behind the transport-level refusals: routing, body size, headers and rate limits.
const (
	ReasonRouteNotFound       = "route_not_found"
	ReasonMethodNotAllowed    = "method_not_allowed"
	ReasonBodyTooLarge        = "body_too_large"
	ReasonQueryInvalid        = "query_invalid"
	ReasonIfMatchRequired     = "if_match_required"
	ReasonIfMatchInvalid      = "if_match_invalid"
	ReasonRateLimited         = "rate_limited"
	ReasonInternal            = "internal"
	ReasonDatabaseUnavailable = "database_unavailable"
)

// Reasons behind a rejected session: the header, the token, and a route reached without one.
const (
	ReasonAuthHeaderMissing = "auth_header_missing"
	ReasonTokenInvalid      = "token_invalid"
	ReasonUnauthenticated   = "unauthenticated"
)

// Reasons behind the account endpoints. The two refresh failures are deliberately distinct:
// an expired token asks the user to sign in again, a replayed one has just revoked every
// session they hold and they need to be told that.
const (
	ReasonLoginBlank           = "login_blank"
	ReasonLoginTaken           = "login_taken"
	ReasonInvalidCredentials   = "invalid_credentials"
	ReasonPasswordInvalid      = "password_invalid"
	ReasonDisplayNameBlank     = "display_name_blank"
	ReasonRefreshInvalid       = "refresh_token_invalid"
	ReasonRefreshReused        = "refresh_token_reused"
	ReasonRecoveryCodeInvalid  = "recovery_code_invalid"
	ReasonRecoveryTokenInvalid = "recovery_token_invalid"
	ReasonSessionIDInvalid     = "session_id_invalid"
	ReasonSessionNotFound      = "session_not_found"
)

// Reasons behind the vault domain errors.
const (
	ReasonNotFound         = "not_found"
	ReasonForbidden        = "forbidden"
	ReasonVersionConflict  = "version_conflict"
	ReasonScopeMismatch    = "scope_mismatch"
	ReasonFolderCycle      = "folder_cycle"
	ReasonDepthExceeded    = "depth_exceeded"
	ReasonShareExpiry      = "share_expiry"
	ReasonLinkBatch        = "link_batch"
	ReasonSignatureInvalid = "signature_invalid"
	ReasonRekeyStale       = "rekey_stale"
	ReasonKeyGrantMissing  = "key_grant_missing"
	ReasonRekeyBatch       = "rekey_batch"
	ReasonEpochMismatch    = "epoch_mismatch"
	ReasonCompactRequired  = "compact_required"
	ReasonUpdateTooLarge   = "update_too_large"
	ReasonLabelIncomplete  = "label_incomplete"
)

// Reasons behind the membership, grant, group and invite errors.
const (
	ReasonOwnerRequired = "owner_required"
	ReasonSelfTarget    = "self_target"
	ReasonAlreadyMember = "already_member"
	ReasonKeysRequired  = "keys_required"
	ReasonGroupMembers  = "group_members"
	ReasonGroupKeyless  = "group_keyless"
	ReasonGroupScopes   = "group_scopes"
	ReasonGroupRotation = "group_rotation"
	ReasonInvitePath    = "invite_path"
	ReasonRedeemPath    = "redeem_path"
)

// Reasons behind the connector endpoints.
const (
	ReasonConnectorRole   = "connector_role_invalid"
	ReasonConnectorExists = "connector_exists"
)

// FailReason answers with a machine-readable cause next to the code. The message stays
// English on purpose: it is what ends up in a log for whoever is debugging, while the
// reason is what the client turns into text for the user.
func FailReason(c *gin.Context, status int, code, reason, message string) {
	FailWithDetails(c, status, code, message, map[string]string{ReasonKey: reason})
}
