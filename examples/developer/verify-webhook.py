"""Call verify(headers, original_body, secret) before parsing a webhook payload."""
import hashlib
import hmac
import time


def verify(headers, original_body: bytes, secret: str) -> str:
    event_id, timestamp = headers["webhook-id"], headers["webhook-timestamp"]
    if abs(time.time() - int(timestamp)) > 300:
        raise ValueError("Expired webhook timestamp")
    message = event_id.encode() + b"." + timestamp.encode() + b"." + original_body
    expected = "v1=" + hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, headers["webhook-signature"]):
        raise ValueError("Invalid webhook signature")
    return event_id
