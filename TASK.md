Create a complete, runnable full-stack e-commerce system named ShopFlow.

ARCHITECTURAL CONSTRAINT

Implement the system at MEDIUM ARCHITECTURAL COMPLEXITY.

Create exactly three repositories:

1. shopflow-web
2. shopflow-api
3. shopflow-infra

The architecture must be three-tier.

shopflow-web:

- React + TypeScript.

shopflow-api:

- TypeScript + Node.js.
- Hexagonal Architecture.
- Separate domain, application/use cases, ports, and adapters.

shopflow-infra:

- Docker Compose.
- PostgreSQL configuration.
- Deterministic local external notification-provider emulator.

FUNCTIONAL REQUIREMENTS

The system must support:

1. Product catalog.
2. Product inventory.
3. Order creation.
4. Inventory validation before order creation.
5. Inventory decrement after successful order creation.
6. Order detail/status view.
7. Administrative action to mark an order as SHIPPED.
8. Order-confirmation notification.
9. Customer order cancellation.

ORDER CANCELLATION RULES

A customer may cancel an order that has not been shipped.

Cancellation must:

- require a non-empty reason of at most 200 characters;
- change the order status to CANCELLED;
- store cancelledAt;
- store cancellationReason;
- restore inventory exactly once;
- send a cancellation notification;
- reject cancellation of SHIPPED orders;
- safely handle repeated cancellation requests without restoring inventory twice.

REPRODUCIBILITY AND QUALITY REQUIREMENTS

- Provide deterministic seed data.
- Provide Docker-based local execution.
- Provide dependency lockfiles.
- Provide automated tests.
- Do not depend on production internet services.
- Do not create additional repositories.
- Do not leave TODOs or placeholder implementations.
- Verify the complete system before finishing.

Do not add business features that are not required by this task.
