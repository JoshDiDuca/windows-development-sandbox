
## Update (later 2026-11-03): os error 1392 on the mapped project folder
Freshly built cargo build-script exes under C:\Projects\AgentProjects\mw2-agent\...\target\*\build\*\build-script-build
fail to run: "The file or directory is corrupted and unreadable (os error 1392)". A mutants .res temp under
C:\Users\WDAGUtilityAccount\.cargo\registry was also unreadable (CVT1101/LNK1123). It is intermittent: one 4-minute
play build passed in the same folder. The host volume was 95% full at the time and is now 1.1T free; the error still
recurred after that. Please check the host side of the mapped folder (Defender/AV on F:, the subst onto C:\Mirror\F, disk health).
