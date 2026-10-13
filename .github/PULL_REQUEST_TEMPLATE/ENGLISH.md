## Outcome

<!-- State the user-visible outcome in one or two sentences. -->

## Why and scope

<!--
- What problem or goal does this address?
- Why does this layer own the change?
- What is intentionally out of scope?
-->

Related issue:

## Verification

| Check | Result |
| --- | --- |
| Automated | `npm run check` |
| Real scenario | |
| Failure or rollback | |

## Impact

| Area | Impact or `None` |
| --- | --- |
| Compatibility and public API | |
| Data and migration | |
| Security and privacy | |
| Cost and resources | |
| Rollback | |

## Release-line decision

- Target branch:
- Backport or forward-port origin:

<!-- support/<major>.x accepts maintenance only. Protected release lines never merge into one another. -->

## Final checklist

- [ ] PR title follows `type(scope)!: description`.
- [ ] The change is focused and includes relevant tests.
- [ ] Public Chinese and English documentation is synchronized.
- [ ] Compatibility, migration, rollback, security, privacy, cost, and resource impact are explicit.
- [ ] The target release line is correct; `support/<major>.x` contains no feature or architecture work.
- [ ] No credential, personal path, account identifier, internal domain, conversation body, or confidential data is included.
- [ ] `npm run check` passes.
- [ ] I understand that only repository owner `@skillnull` may merge or update `main` and `support/*`.
