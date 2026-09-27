import numpy as np, wave
from PIL import Image, ImageDraw, ImageFilter

T='Assets/Textures/'
# 1. Background overlay: clear center, soft top/bottom shade, faint colored corners, light vignette.
W,H=540,960
y=np.linspace(0,1,H)[:,None]; x=np.linspace(0,1,W)[None,:]
top=np.clip(1-y/0.22,0,1)**2*0.42
bot=np.clip((y-0.72)/0.28,0,1)**2*0.38
d=np.sqrt(((x-0.5)/0.62)**2+((y-0.48)/0.62)**2)
vig=np.clip((d-0.72)/0.5,0,1)**1.6*0.35
a=np.clip(top+bot+vig,0,0.6)
pink=np.exp(-(((x-0.0)/0.45)**2+((y-1.0)/0.3)**2))*0.22
cyan=np.exp(-(((x-1.0)/0.45)**2+((y-0.0)/0.3)**2))*0.18
r=12+200*pink+20*cyan; g=8+40*pink+150*cyan; b=30+160*pink+230*cyan
a=np.clip(a+pink*0.5+cyan*0.5,0,0.65)
img=np.dstack([np.clip(c*np.ones_like(a),0,255) for c in (r,g,b)]+[a*255]).astype(np.uint8)
Image.fromarray(img,'RGBA').save(T+'BackgroundOverlay.png',optimize=True)

# 2. Glass card (dark translucent, gradient rim, top sheen, soft shadow).
S=2; CW,CH,PAD,R=820,380,48,64
w,h=(CW+PAD*2)*S,(CH+PAD*2)*S
shadow=Image.new('L',(w,h),0); ImageDraw.Draw(shadow).rounded_rectangle([PAD*S,(PAD+14)*S,(PAD+CW)*S,(PAD+CH+14)*S],R*S,fill=120)
shadow=shadow.filter(ImageFilter.GaussianBlur(22*S))
out=Image.new('RGBA',(w,h),(0,0,0,0)); out.putalpha(shadow)
body=Image.new('RGBA',(w,h),(0,0,0,0))
mask=Image.new('L',(w,h),0); ImageDraw.Draw(mask).rounded_rectangle([PAD*S,PAD*S,(PAD+CW)*S,(PAD+CH)*S],R*S,fill=255)
yy=np.linspace(0,1,h)[:,None]*np.ones((1,w)); xx=np.ones((h,1))*np.linspace(0,1,w)[None,:]
fill=np.dstack([22+30*xx,16+10*yy,48+40*(1-yy),(0.46-0.1*yy)*255]).astype(np.uint8)
body=Image.fromarray(fill,'RGBA'); body.putalpha(Image.fromarray((np.array(mask)*(0.46-0.1*yy)).astype(np.uint8)))
out=Image.alpha_composite(out,body)
# sheen on the top third
sheen=Image.new('L',(w,h),0); ImageDraw.Draw(sheen).rounded_rectangle([(PAD+6)*S,(PAD+6)*S,(PAD+CW-6)*S,(PAD+CH*0.45)*S],(R-6)*S,fill=255)
sa=(np.array(sheen)/255.0)*np.clip(1-(yy-PAD/(CH+2*PAD))/0.25,0,1)*0.10*255
out=Image.alpha_composite(out,Image.fromarray(np.dstack([np.full((h,w),255)]*3+[sa]).astype(np.uint8),'RGBA'))
# gradient rim (pink → violet → cyan)
rim=Image.new('L',(w,h),0); ImageDraw.Draw(rim).rounded_rectangle([PAD*S,PAD*S,(PAD+CW)*S,(PAD+CH)*S],R*S,outline=255,width=3*S)
ra=np.array(rim)/255.0*(0.55+0.3*(1-yy))
rc=np.dstack([255*(1-xx)+90*xx,70*(1-xx)+220*xx,170*(1-xx)+255*xx,ra*255]).astype(np.uint8)
out=Image.alpha_composite(out,Image.fromarray(rc,'RGBA'))
out=out.resize((w//S,h//S),Image.LANCZOS); out.save(T+'QuestionCard.png',optimize=True)

# 3. Card glow: blurred white rounded rect (tinted in-engine by the accent color).
g=Image.new('L',(CW+PAD*4,CH+PAD*4),0); ImageDraw.Draw(g).rounded_rectangle([PAD*2,PAD*2,PAD*2+CW,PAD*2+CH],R,fill=255)
g=g.filter(ImageFilter.GaussianBlur(34)); ga=(np.array(g)*0.9).astype(np.uint8)
Image.fromarray(np.dstack([np.full_like(ga,255)]*3+[ga]),'RGBA').resize(((CW+PAD*4)//2,(CH+PAD*4)//2),Image.LANCZOS).save(T+'CardGlow.png',optimize=True)

# 4. Radial glow (countdown / burst).
N=256; yy,xx=np.mgrid[0:N,0:N]; rr=np.sqrt((xx-N/2+0.5)**2+(yy-N/2+0.5)**2)/(N/2)
ra=np.clip(1-rr,0,1)**2.2*255
Image.fromarray(np.dstack([np.full((N,N),255)]*3+[ra]).astype(np.uint8),'RGBA').save(T+'RadialGlow.png',optimize=True)

# 5. Flash: 8×8 white (stretched full-screen).
Image.new('RGBA',(8,8),(255,255,255,255)).save(T+'Flash.png')

# ---- SFX (44.1 kHz mono 16-bit, short & soft) ----
SR=44100
def save(name,sig):
    sig=sig/np.max(np.abs(sig))*0.5
    with wave.open('Assets/Audio/'+name,'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(SR); f.writeframes((sig*32767).astype('<i2').tobytes())
def env(n,a,d): t=np.arange(n)/SR; return np.minimum(1,t/a)*np.exp(-t/d)
rng=np.random.default_rng(1)
n=int(0.09*SR); t=np.arange(n)/SR
save('sfx_tick.wav', (np.sin(2*np.pi*1250*t)+0.4*np.sin(2*np.pi*2500*t))*env(n,0.002,0.025)+rng.normal(0,1,n)*env(n,0.0005,0.004)*0.3)
n=int(0.42*SR); t=np.arange(n)/SR
f=420+700*(1-np.exp(-t/0.03)); pop=np.sin(2*np.pi*np.cumsum(f)/SR)*env(n,0.003,0.09)
spark=sum(np.sin(2*np.pi*fr*t)*np.exp(-np.maximum(0,t-dl)/0.08)*(t>dl) for fr,dl in ((2093,0.04),(2637,0.08),(3136,0.12)))*0.25
save('sfx_now.wav', pop+spark)
n=int(0.28*SR); t=np.arange(n)/SR; noise=rng.normal(0,1,n)
k=np.exp(-np.linspace(-3,3,301)**2); noise=np.convolve(noise,k/k.sum(),'same')
save('sfx_whoosh.wav', noise*np.sin(np.pi*t/t[-1])**2)
print('ok')
