# HCS schema (test fixtures)

The Host Compute Service JSON schema (OpenAPI / Swagger 2.0) as Microsoft publishes it, used only by the self-test
(`hcs` suite) to check that the documents `src/host/engines/hcs/documents.ts` builds use real property names and
values. Not part of the published package.

Source: [MicrosoftDocs/Virtualization-Documentation](https://github.com/MicrosoftDocs/Virtualization-Documentation),
`hyperv-samples/hcs-samples/JSON_files/` (the Windows 11 SDK 21H2 and Windows 10 SDK 1809 versions, content
unchanged; renamed from `HCS_Schema[Windows_11_SDK_version_21H2].json` and `HCS_Schema[Windows_10_SDK_version_1809].json`
to `windows-11-21h2.json` and `windows-10-1809.json`).
Copyright Microsoft Corporation, licensed under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
