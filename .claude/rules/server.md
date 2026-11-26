---
paths:
  - "server/src/**/*.ts"
---

# Server files

- Keep business logic out of route handlers. Existing handlers may violate this: refactor them as you make updates.
- Keep a separate business logic layer with a strong object-oriented design.
- Follow SOLID principles.
