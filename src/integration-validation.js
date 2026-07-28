import net from "node:net";

function privateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

export function validateSpotifyRedirectUri(value) {
  const redirectUri = String(value || "").trim();
  if (!redirectUri) {
    return {
      valid: false,
      error: "Enter a Spotify redirect URI before connecting.",
      suggestedUri: "http://127.0.0.1:8787/auth/spotify/callback",
    };
  }
  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return {
      valid: false,
      error: "The Spotify redirect URI is not a valid absolute URL.",
      suggestedUri: "http://127.0.0.1:8787/auth/spotify/callback",
    };
  }
  if (parsed.pathname !== "/auth/spotify/callback" || parsed.search || parsed.hash) {
    return {
      valid: false,
      error: "The Spotify callback must end exactly with /auth/spotify/callback.",
      suggestedUri: "http://127.0.0.1:8787/auth/spotify/callback",
    };
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === "127.0.0.1" || hostname === "[::1]";
  if (parsed.protocol === "http:" && !loopback) {
    return {
      valid: false,
      error: "Spotify permits plain HTTP only for an explicit 127.0.0.1 or [::1] loopback callback.",
      suggestedUri: "http://127.0.0.1:8787/auth/spotify/callback",
    };
  }
  if (parsed.protocol === "https:") {
    if (
      hostname === "localhost" ||
      hostname === "[::1]" ||
      (net.isIP(hostname) === 4 && privateIpv4(hostname))
    ) {
      return {
        valid: false,
        error: "A private LAN IP cannot provide the trusted public HTTPS callback Spotify requires. Use the loopback callback through the phone or an SSH tunnel.",
        suggestedUri: "http://127.0.0.1:8787/auth/spotify/callback",
      };
    }
    return { valid: true, error: null, suggestedUri: null };
  }
  if (parsed.protocol !== "http:") {
    return {
      valid: false,
      error: "Spotify redirect URIs must use HTTPS, except for the explicit loopback HTTP exception.",
      suggestedUri: "http://127.0.0.1:8787/auth/spotify/callback",
    };
  }
  return { valid: true, error: null, suggestedUri: null };
}

export default validateSpotifyRedirectUri;
