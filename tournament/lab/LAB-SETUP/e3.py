from run import *
import sx
B=dict(wins=[510,660,810,960],exit_min=955)
for rr in (0.25,0.3,0.35,0.45):
    evalp(sx,{**B,'max_per_day':3,'rr':rr},label=f'mpd3 rr{rr}')
for rr in (0.35,0.4):
    evalp(sx,{**B,'max_per_day':4,'rr':rr},label=f'mpd4 rr{rr}')
evalp(sx,{'rr':0.4},label='base AM-only rr0.4')
evalp(sx,{'rr':0.4,'max_per_day':3},label='AM-only mpd3 rr0.4')
