---
trigger: always_on
---

# MASTER AGENT RULES

1. PROJECT IDENTITY

Project:
StreamVerse

Purpose:
A Web3 pay-as-you-watch streaming ecosystem using blockchain
micropayments, creator royalties, token rewards and AI.

Primary blockchain:
Polygon

Development network:
Polygon Amoy Testnet

Primary token:
StreamCoin (STRM)

--------------------------------------------------

2. NON-NEGOTIABLE ARCHITECTURE

The system MUST use modular boundaries.

No module may directly access another module's internal
database tables.

Communication between modules must happen through:
- public interfaces
- APIs
- domain events
- shared contracts

Internal implementation details must never leak across modules.

--------------------------------------------------

3. FAULT TOLERANCE

Failure of a non-critical module MUST NOT stop:

- authentication
- catalog browsing
- video playback
- watch tracking
- payment authorization

AI failure:
→ use trending-content fallback.

Blockchain RPC failure:
→ queue settlement and continue playback if
internal entitlement is valid.

Analytics failure:
→ queue events for later processing.

Recommendation failure:
→ return fallback recommendations.

--------------------------------------------------

4. BLOCKCHAIN

Blockchain MUST NOT be used for:

- storing video files
- storing thumbnails
- storing watch heartbeats
- storing recommendation data
- storing analytics events

Blockchain SHOULD be used for:

- token ownership
- creator payments
- settlement
- royalty distribution
- verifiable transactions

Never perform a blockchain transaction for every second
of video playback.

--------------------------------------------------

5. VIDEO

Video files MUST NOT be stored on-chain.

Use:

Object Storage / IPFS
+
FFmpeg
+
HLS

Playback must use short-lived authorization.

Never expose permanent public video URLs for protected content.

--------------------------------------------------

6. DATABASE

PostgreSQL is the source of truth for application state.

Redis is used for:

- caching
- temporary sessions
- queues
- event processing

Redis MUST NOT be treated as permanent storage.

--------------------------------------------------

7. AI

AI is NON-CRITICAL.

No core feature may require an AI response to function.

Every AI feature must have a deterministic fallback.

--------------------------------------------------

8. SECURITY

Never trust client-provided:

- watch duration
- token balance
- creator revenue
- reward amount
- playback authorization
- wallet ownership

All financial calculations MUST happen server-side
or inside smart contracts.

--------------------------------------------------

9. AGENT BEHAVIOR

Before implementing a feature:

1. Identify the module.
2. Read its constraints.
3. Identify dependencies.
4. Check existing interfaces.
5. Check whether the feature violates architecture.
6. Implement the smallest correct solution.
7. Write tests.
8. Update documentation.

Never invent an API, database table, contract function,
environment variable or dependency without documenting it.

--------------------------------------------------

10. NO HALLUCINATION RULE

If required information does not exist:

DO NOT GUESS.

Mark:

UNKNOWN

and ask for clarification or inspect the repository.

Never fabricate:
- APIs
- blockchain addresses
- contract ABIs
- environment variables
- database columns
- package versions
- credentials
- external services

--------------------------------------------------

11. SCOPE

The project has a 2-month deadline.

Prefer:

simple + reliable + modular

over:

complex + theoretically perfect + unfinished.

Do not introduce a technology merely because it is trendy.

--------------------------------------------------

12. DEFINITION OF DONE

A feature is NOT complete until:

- implementation exists
- tests exist
- error handling exists
- failure behavior is defined
- API/interface is documented
- security implications are considered
- existing functionality still works