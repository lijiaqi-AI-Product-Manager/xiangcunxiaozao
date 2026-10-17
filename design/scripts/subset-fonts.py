#!/usr/bin/env python3
"""字体子集化：霞鹜文楷 + Cinzel → woff2（页面字符集裁剪）"""
import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
F = ROOT + "/src/assets/fonts"
chars = open(ROOT + "/scripts/charset.txt", encoding="utf-8").read().strip()

# 文楷：中文子集（含常用拉丁兜底）
subprocess.run([
    sys.executable, "-m", "fontTools.subset",
    f"{F}/LXGWWenKai-Regular.ttf",
    f"--text={chars}ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,:;/()[]'\"-–—&+*%$#@!?",
    "--output-file=" + F + "/wenkai-sub.woff2",
    "--flavor=woff2", "--layout-features=*", "--no-hinting",
], check=True)

# Cinzel：拉丁大写为主（en-cap 全大写+数字）
subprocess.run([
    sys.executable, "-m", "fontTools.subset",
    f"{F}/Cinzel.ttf",
    "--unicodes=U+0020-007E",
    "--output-file=" + F + "/cinzel-sub.woff2",
    "--flavor=woff2", "--no-hinting",
], check=True)
print("字体子集完成:", os.path.getsize(F + "/wenkai-sub.woff2") // 1024, "KB +",
      os.path.getsize(F + "/cinzel-sub.woff2") // 1024, "KB")
