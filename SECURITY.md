# Reporting a security problem

nosyparker edits the configuration files of other programs and keeps a file of
what people tell their agents. Both are worth reporting problems about
privately first.

**Report it privately** through GitHub's private vulnerability reporting on
this repository — *Security* → *Report a vulnerability* — which reaches the
maintainer and nobody else. If that route is unavailable, open an issue that
says only that you have something to report privately, without the details,
and a way to reach you will be arranged.

What counts: anything that lets a memory be stored that the gate says it
refuses, anything that lets a secret reach the file or the decision log,
anything `setup` or `uninstall` does to a file it did not say it would touch,
and anything that makes a network request — there are none, by design.

What is out of scope: the limits the documents already state. The credential
screen is a screen and not a guarantee, and DECISIONS.md records what it is
known to miss. A report that a listed limit exists is a document request, not
a vulnerability.

Fixes go out as a new version through the release workflow; nothing is
published by hand. Please give a reasonable time for a fix before writing about
a problem publicly.
