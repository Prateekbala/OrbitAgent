"""Orbit API v1 client. Credentials are never included in representations or errors."""
import json
from urllib.parse import urlsplit, urlencode, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from .operations import OPERATIONS


class OrbitError(Exception):
    def __init__(self, status, code, message, request_id=None):
        super().__init__(message)
        self.status, self.code, self.request_id = status, code, request_id


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class OrbitClient:
    def __init__(self, base_url, token, timeout=30):
        url = urlsplit(base_url)
        if url.username or url.password or url.query or url.fragment or not (
            url.scheme == "https" or (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1"))
        ):
            raise ValueError("Use HTTPS, or loopback HTTP for local development.")
        if not 0 < timeout <= 120:
            raise ValueError("Timeout must be between 0 and 120 seconds.")
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout
        self._opener = build_opener(_NoRedirect())

    def request(self, operation, *, path=None, query=None, body=None):
        """No automatic retries. Preserve clientId/requestKey when retrying a write."""
        definition = OPERATIONS[operation]
        endpoint = definition["path"]
        for name, value in (path or {}).items():
            endpoint = endpoint.replace("{" + name + "}", quote(str(value), safe=""))
        if "{" in endpoint:
            raise ValueError("Missing API path parameter.")
        url = self._base_url + endpoint
        if query:
            url += "?" + urlencode({k: str(v).lower() if isinstance(v, bool) else v for k, v in query.items() if v is not None})
        token = self._token() if callable(self._token) else self._token
        headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        request = Request(url, data=data, headers=headers, method=definition["method"])
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                return json.loads(response.read(2_000_001))
        except HTTPError as error:
            try:
                details = json.loads(error.read(128_000)).get("error", {})
            except (ValueError, AttributeError):
                details = {}
            raise OrbitError(error.code, details.get("code", "REQUEST_FAILED"), details.get("message", "The API request failed."), details.get("requestId")) from None
