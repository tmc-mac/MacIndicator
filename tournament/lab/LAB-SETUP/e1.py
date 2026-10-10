from run import *
import sx
evalp(sx,{},label='base')
for w,name in [([510,660,810,960],'AM+PM810-960'),([510,660,810,900],'AM+PM810-900'),([510,660,720,960],'AM+720-960'),([510,960],'510-960')]:
    evalp(sx,dict(wins=w,exit_min=955),label=name+' mpd2')
    evalp(sx,dict(wins=w,exit_min=955,max_per_day=3),label=name+' mpd3')
