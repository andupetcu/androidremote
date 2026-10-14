/**
 * External base URL of this server, from configuration only (SS-14). It ends up in installers, enrolment
 * responses, provisioning QR data and START_REMOTE payloads, so it must not follow the request's Host or
 * X-Forwarded-* headers. Set PUBLIC_BASE_URL (for example https://mdm.example.com); BASE_URL is the older name.
 * Without either, the URL falls back to http://localhost:<PORT>, which is only right for local development.
 */
export function getPublicBaseUrl(): string {
  const configured = process.env.PUBLIC_BASE_URL || process.env.BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT || 7899}`;
}
