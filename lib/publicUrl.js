/** Base URL of this API (for links in emails and reset page). */
export function publicApiBase() {
  return (
    process.env.API_PUBLIC_URL ||
    process.env.PUBLIC_API_URL ||
    // `http://localhost:${process.env.PORT || 3001}`
    `https://www.qrixa.net`
  );
}
