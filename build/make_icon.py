from PIL import Image, ImageDraw, ImageFilter

S = 1024
R = 214  # 圆角，让蓝底几乎铺满整张画布，四角无白色留白

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 圆角方形蒙版
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=R, fill=255)

# 蓝色竖向渐变背景
top = (88, 156, 232, 255)
bot = (43, 120, 230, 255)
grad = Image.new("RGBA", (1, S))
for y in range(S):
    t = y / (S - 1)
    c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
    grad.putpixel((0, y), c)
grad = grad.resize((S, S))
bg = Image.composite(grad, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask)
img.paste(bg, (0, 0), mask)

# 笔记本软阴影
nx0, ny0, nx1, ny1 = 302, 246, 722, 778
sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(sh).rounded_rectangle(
    [nx0 + 4, ny0 + 16, nx1 + 4, ny1 + 16], radius=40, fill=(0, 0, 0, 80)
)
sh = sh.filter(ImageFilter.GaussianBlur(20))
img = Image.alpha_composite(img, sh)

d = ImageDraw.Draw(img)

# 笔记本白页
d.rounded_rectangle([nx0, ny0, nx1, ny1], radius=34, fill=(255, 255, 255, 255))
# 左侧蓝色书脊
d.rounded_rectangle([nx0, ny0, nx0 + 74, ny1], radius=34, fill=(211, 227, 248, 255))
d.rectangle([nx0 + 46, ny0, nx0 + 74, ny1], fill=(211, 227, 248, 255))
# 装订圈
for ry in range(ny0 + 52, ny1 - 30, 78):
    d.ellipse([nx0 + 10, ry - 10, nx0 + 30, ry + 10], outline=(43, 120, 230, 255), width=7)
# 标题条（蓝）
d.rounded_rectangle([nx0 + 116, ny0 + 54, nx1 - 46, ny0 + 82], radius=12, fill=(43, 120, 230, 255))
# 正文行（浅蓝）
lx0 = nx0 + 116
lx1 = nx1 - 46
for i, ly in enumerate([ny0 + 128, ny0 + 190, ny0 + 252]):
    w = lx1 if i < 2 else lx1 - 130
    d.rounded_rectangle([lx0, ly, w, ly + 18], radius=9, fill=(198, 216, 238, 255))
# 右下角一个勾选小标记，点缀「笔记」感
d.ellipse([lx1 - 92, ny1 - 96, lx1 - 46, ny1 - 50], fill=(43, 120, 230, 255))
d.line([(lx1 - 82, ny1 - 74), (lx1 - 70, ny1 - 60)], fill=(255, 255, 255, 255), width=8)
d.line([(lx1 - 70, ny1 - 60), (lx1 - 54, ny1 - 88)], fill=(255, 255, 255, 255), width=8)

img.save("build/icon.png")
print("saved", img.size)

# 同步生成 Linux 多尺寸图标集。
# electron-builder 的 linux.icon 指向该目录时，会按 hicolor 规范把各尺寸图标
# 安装到 /usr/share/icons/hicolor/<NxN>/apps/；若只给单张 PNG，已知 bug 会把它
# 装进 hicolor/0x0/ 非法目录，导致 Deepin/UOS 等桌面启动器检索不到图标。
import os

ICON_DIR = "build/icons"
SIZES = (16, 24, 32, 48, 64, 96, 128, 256, 512, 1024)
os.makedirs(ICON_DIR, exist_ok=True)
for s in SIZES:
    img.resize((s, s), Image.LANCZOS).save(f"{ICON_DIR}/{s}x{s}.png")
print("saved iconset", ICON_DIR, [f"{s}x{s}.png" for s in SIZES])
