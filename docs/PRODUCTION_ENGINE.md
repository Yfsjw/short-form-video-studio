# Production Engine

## Purpose

This engine is separate from the existing video-repurposing pipeline. It is designed for the eventual workflow:

`create video` -> idea -> research -> script -> visual plan -> assets -> voice -> edit -> captions -> sound -> render -> QC -> final MP4.

## Runtime decision

Render is intentionally not part of this architecture.

The core engine is runtime-neutral:

- GitHub is the source of truth for code and manifests.
- GitHub Actions is the first CPU execution target for deterministic media work and integration tests.
- GPU/AI work is isolated behind provider interfaces. Hugging Face ZeroGPU may be used for selected AI workloads, but the core renderer must not depend on it.
- Persistent object storage is deliberately deferred until the engine has a real artifact lifecycle.

## Non-negotiable rules

1. A green workflow is not proof of a valid video.
2. A production job is successful only after a real MP4 exists and passes media-level QC.
3. Providers are adapters. The production domain must not import vendor SDKs directly.
4. Existing clip-repurposing routes remain separate from the new production workflow.
5. No mock assets, fake timestamps, placeholder MP4s, or hard-coded "successful" states.
6. Every stage emits a machine-readable artifact and status.
7. Failed stages are resumable from the last valid artifact.

## First implementation milestone

The first milestone is the **production contract**:

- a typed production job;
- a versioned production manifest;
- explicit scene/asset/voice/edit specifications;
- validation before execution;
- deterministic artifact naming;
- a provider-neutral orchestrator boundary.

No stage is allowed to pretend it can generate an asset until a real provider implementation exists.
