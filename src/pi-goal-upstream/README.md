# Runtime inputs and local customization

The two TypeScript helpers and MIT license are copied byte-for-byte from
Michaelliv/pi-goal v0.1.7. They live under src so the existing Pi TypeScript/Docker
build includes them without loading the classic extension.

The bundled writer skill is intentionally customized for cuse IRC: mutable goal
files in the channel desktop's MCPJS /data/memory, short references, and current
file reads/updates. It is injected directly into goal-enabled durable sessions
because cuse does not expose a host filesystem read tool.

The complete pristine upstream snapshot remains under vendor/pi-goal. Its
provenance manifest records upstream files plus the runtime skill customization's
original and local hashes. Packaging tests reject unexplained drift.
