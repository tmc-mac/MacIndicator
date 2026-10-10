from run import *
import sx
B=dict(wins=[510,660,810,960],exit_min=955)
for mpd in (4,6):
    evalp(sx,{**B,'max_per_day':mpd},label=f'mpd{mpd}')
for rr in (0.4,0.6,0.75):
    evalp(sx,{**B,'max_per_day':3,'rr':rr},label=f'mpd3 rr{rr}')
for ms in (30,40):
    evalp(sx,{**B,'max_per_day':3,'max_stop':ms},label=f'mpd3 maxstop{ms}')
for ks in (0.7,1.0):
    evalp(sx,{**B,'max_per_day':3,'k_disp':ks},label=f'mpd3 kdisp{ks}')
for cn in (10,30):
    evalp(sx,{**B,'max_per_day':3,'cancel':cn},label=f'mpd3 cancel{cn}')
