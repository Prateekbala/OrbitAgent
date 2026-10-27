import os
import uuid
from orbit_sdk import OrbitClient

client = OrbitClient(os.getenv("ORBIT_API_URL", "http://localhost:3000/api/public/v1"), lambda: os.environ["ORBIT_API_KEY"])
request_id = str(uuid.uuid4())
result = client.request("createTask", body={"clientId": request_id, "title": "Review integration contract", "conversationId": os.environ["ORBIT_CONVERSATION_ID"]})
print(result["id"])
