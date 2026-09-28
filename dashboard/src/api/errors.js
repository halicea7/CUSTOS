// Turn an axios error into a human-readable message.
// FastAPI returns `detail` as a string for HTTPException, but as a list of
// {loc, msg} objects for validation (422) errors — rendering that list
// directly would crash React.
export function errorMessage(err, fallback = "Something went wrong") {
  const detail = err?.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((d) => {
        const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
        return field ? `${field}: ${d.msg}` : d.msg;
      })
      .join("; ");
  }
  if (err?.response?.status === 429) return "Too many attempts — try again later.";
  return fallback;
}
