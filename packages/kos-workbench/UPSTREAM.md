# KOS workbench provenance

The initial object parser, dashboard calculations, layout math and reading adapters are adapted
from `kos-framework` commit `99e3d12d71be177efe2739bd51e2d9cce35e69a2` (`ob-plugin/src/core`,
`ob-plugin/src/reader/model.ts`, and `ob-plugin/src/views/reader/adapters`). The original MIT
license is retained in `LICENSE.kos-framework`.

These are a migration baseline, not a commitment to the previous Agent framework. There is no
Obsidian or DSH dependency. UI actions express explicit human changes; Agent-generated plans,
research, summaries and reviews remain outside this module until their quality work is complete.

The shared browser UI runs as a Desktop `mainView` plugin and in the iOS WebView. Each host
supplies only an HTTP transport and durable local storage. Source documents remain Markdown;
unknown YAML fields and comments are preserved during targeted edits. Host settings and paths
are never bundled into source. The personal relay URL is supplied by the actual host route or
the locally prepared plugin package configuration.
