"""Build LevelsPRO-TIDE-v2.8.pine: companion-head + tide-engine + tide-display (without the main-only t_tag) + companion-tail."""
import sys, os, re
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
rd = lambda n: open(os.path.join(D, n), encoding="utf-8").read()
eng = rd("tide-engine.pine").replace("// == TIDE ENGINE END ========================================================\n", "")
dsp = rd("tide-display.pine")
a = dsp.index("// one tag's TIDE word and tooltip"); b = dsp.index("// the HUD rows (17E reads them)")
dsp = dsp[:a] + dsp[b:]
out = rd("companion-head.pine") + eng + dsp + "// == TIDE ENGINE END ========================================================\n" + rd("companion-tail.pine")
open(sys.argv[1], "w", encoding="utf-8").write(out)
print("built", sys.argv[1], len(out.split("\n")), "lines")
