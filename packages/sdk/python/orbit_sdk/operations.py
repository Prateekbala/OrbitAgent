OPERATIONS = {
  "listTasks": {
    "method": "GET",
    "path": "/tasks"
  },
  "getTask": {
    "method": "GET",
    "path": "/tasks/{id}"
  },
  "createTask": {
    "method": "POST",
    "path": "/tasks"
  },
  "updateTask": {
    "method": "PATCH",
    "path": "/tasks/{id}"
  },
  "transitionTask": {
    "method": "POST",
    "path": "/tasks/{id}/transitions"
  },
  "commentOnTask": {
    "method": "POST",
    "path": "/tasks/{id}/comments"
  },
  "messageHistory": {
    "method": "GET",
    "path": "/conversations/{id}/messages"
  },
  "sendMessage": {
    "method": "POST",
    "path": "/conversations/{id}/messages"
  },
  "editMessage": {
    "method": "PATCH",
    "path": "/messages/{id}"
  },
  "deleteMessage": {
    "method": "DELETE",
    "path": "/messages/{id}"
  },
  "getKnowledgePage": {
    "method": "GET",
    "path": "/knowledge/{id}"
  },
  "createKnowledgePage": {
    "method": "POST",
    "path": "/knowledge"
  },
  "editKnowledgePage": {
    "method": "PATCH",
    "path": "/knowledge/{id}"
  },
  "projectReport": {
    "method": "GET",
    "path": "/projects/{id}/report"
  },
  "search": {
    "method": "GET",
    "path": "/search"
  },
  "startRun": {
    "method": "POST",
    "path": "/runs"
  },
  "getRun": {
    "method": "GET",
    "path": "/runs/{id}"
  },
  "cancelRun": {
    "method": "POST",
    "path": "/runs/{id}/cancel"
  },
  "listAutomations": {
    "method": "GET",
    "path": "/automations"
  },
  "getAutomation": {
    "method": "GET",
    "path": "/automations/{id}"
  },
  "createAutomation": {
    "method": "POST",
    "path": "/automations"
  },
  "reviseAutomation": {
    "method": "POST",
    "path": "/automations/{id}/revisions"
  },
  "controlAutomation": {
    "method": "POST",
    "path": "/automations/{id}/control"
  },
  "events": {
    "method": "GET",
    "path": "/events"
  }
}
