# Review policy

## Thread reuse

The test named "thread reuse policy" in `test/thread-dedupe.test.ts` is the specification for matching a new finding to an open review thread or checklist entry.

Behaviour that matches a row in that test is correct. A suggested pairing that would change one of those rows is a policy change, not a defect, and should not be reported.

- Same-title findings that share one line offset keep their own threads, in order. This includes a finding whose line equals another thread's current line. Threads at 10 and 20 with findings at 20 and 30 stay paired 20 with the thread at 10, and 30 with the thread at 20. Findings at 12 and 14 stay with threads at 10 and 12.
- A lone finding within 15 lines of its thread is the same finding. A lone finding at line 500 against a thread or checklist entry at line 10 is a different finding. This still holds when GitHub has cleared the thread's current line and left `originalLine` at 10.
- The only open thread for a file and title is reused when a finding moves between a line comment and a file comment. A file-level finding at line 80 reuses the thread at line 40. A file comment with no line is reused for the same path and title.
