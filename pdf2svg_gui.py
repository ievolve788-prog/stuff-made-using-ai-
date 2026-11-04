#!/usr/bin/env python3
"""PDF -> SVG / vector PDF tracer (GUI). Uses pdftoppm + potrace + pdfunite.

Run:  python3 pdf2svg_gui.py            (opens window)
      python3 pdf2svg_gui.py file.pdf   (opens window with file preselected)
"""
import glob
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

NEEDED = ["pdftoppm", "potrace", "pdfunite"]


def page_sizes(pdf):
    """Exact page sizes (w, h in pt) of the original, so the trace lines up perfectly."""
    import re
    out = subprocess.run(["pdfinfo", "-f", "1", "-l", "9999", pdf], stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE).stdout.decode(errors="ignore")
    return [(m[0], m[1]) for m in re.findall(r"Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)", out)]


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


class App(tk.Tk):
    def __init__(self, preset=None):
        super().__init__()
        self.title("PDF → SVG Tracer")
        self.geometry("560x430")
        self.pdf = tk.StringVar(value=preset or "")
        self.dpi = tk.IntVar(value=300)
        self.thresh = tk.DoubleVar(value=0.50)
        self.speckle = tk.IntVar(value=4)
        self.make_svg = tk.BooleanVar(value=True)
        self.make_pdf = tk.BooleanVar(value=True)
        self.overlay = tk.BooleanVar(value=True)

        pad = {"padx": 10, "pady": 5}
        f = ttk.Frame(self)
        f.pack(fill="both", expand=True, **pad)

        ttk.Label(f, text="PDF file:").grid(row=0, column=0, sticky="w")
        ttk.Entry(f, textvariable=self.pdf, width=45).grid(row=0, column=1, sticky="we")
        ttk.Button(f, text="Browse…", command=self.browse).grid(row=0, column=2, padx=4)

        ttk.Label(f, text="Quality (DPI):").grid(row=1, column=0, sticky="w")
        ttk.Spinbox(f, from_=100, to=600, increment=50, textvariable=self.dpi, width=8).grid(row=1, column=1, sticky="w")

        ttk.Label(f, text="Black threshold:").grid(row=2, column=0, sticky="w")
        ttk.Scale(f, from_=0.2, to=0.8, variable=self.thresh, command=self._upd).grid(row=2, column=1, sticky="we")
        self.tl = ttk.Label(f, text="0.50")
        self.tl.grid(row=2, column=2)

        ttk.Label(f, text="Ignore specks (px):").grid(row=3, column=0, sticky="w")
        ttk.Spinbox(f, from_=0, to=50, textvariable=self.speckle, width=8).grid(row=3, column=1, sticky="w")

        ttk.Checkbutton(f, text="Save one SVG per page", variable=self.make_svg).grid(row=4, column=1, sticky="w")
        ttk.Checkbutton(f, text="Save combined vector PDF", variable=self.make_pdf).grid(row=5, column=1, sticky="w")

        ttk.Checkbutton(f, text="Save original PDF + vector overlay (keeps your scan, sharp when zoomed)",
                        variable=self.overlay).grid(row=6, column=1, columnspan=2, sticky="w")

        self.btn = ttk.Button(f, text="Convert", command=self.start)
        self.btn.grid(row=7, column=1, pady=8)
        self.bar = ttk.Progressbar(f, mode="determinate")
        self.bar.grid(row=8, column=0, columnspan=3, sticky="we")
        self.log = tk.Text(f, height=9, state="disabled")
        self.log.grid(row=9, column=0, columnspan=3, sticky="nsew", pady=5)
        f.columnconfigure(1, weight=1)
        f.rowconfigure(9, weight=1)

        missing = [c for c in NEEDED if not shutil.which(c)]
        if missing:
            self.say("Missing tools: %s\nRun: sudo apt install poppler-utils potrace" % ", ".join(missing))
            self.btn.state(["disabled"])

    def _upd(self, _):
        self.tl.config(text="%.2f" % self.thresh.get())

    def browse(self):
        p = filedialog.askopenfilename(filetypes=[("PDF", "*.pdf")])
        if p:
            self.pdf.set(p)

    def say(self, msg):
        self.log.config(state="normal")
        self.log.insert("end", msg + "\n")
        self.log.see("end")
        self.log.config(state="disabled")

    def start(self):
        p = self.pdf.get()
        if not os.path.isfile(p):
            messagebox.showerror("Error", "Choose a PDF first.")
            return
        if self.overlay.get() and not shutil.which("qpdf"):
            messagebox.showerror("Error", "Overlay needs qpdf.\nRun: sudo apt install qpdf")
            return
        if not (self.make_svg.get() or self.make_pdf.get() or self.overlay.get()):
            messagebox.showerror("Error", "Tick at least one output.")
            return
        self.btn.state(["disabled"])
        threading.Thread(target=self.work, args=(p,), daemon=True).start()

    def ui(self, fn, *a):
        self.after(0, fn, *a)

    def work(self, pdf):
        try:
            dpi, k, t = str(self.dpi.get()), str(round(self.thresh.get(), 2)), str(self.speckle.get())
            base = os.path.splitext(os.path.basename(pdf))[0]
            out = os.path.join(os.path.dirname(pdf), base + "_vectorized")
            os.makedirs(out, exist_ok=True)
            tmp = tempfile.mkdtemp()
            self.ui(self.say, "Extracting pages at %s DPI…" % dpi)
            run(["pdftoppm", "-r", dpi, "-gray", pdf, os.path.join(tmp, "p")])
            pages = sorted(glob.glob(os.path.join(tmp, "p-*.pgm")))
            self.ui(self.bar.config, {"maximum": len(pages), "value": 0})
            pdfs = []
            sizes = page_sizes(pdf)
            for i, img in enumerate(pages, 1):
                n = os.path.basename(img)[:-4]
                if self.make_svg.get():
                    run(["potrace", img, "-s", "-r", dpi, "-k", k, "-t", t, "-o", os.path.join(out, n + ".svg")])
                if self.make_pdf.get() or self.overlay.get():
                    pp = os.path.join(tmp, n + ".pdf")
                    size = ["-W", sizes[i - 1][0] + "pt", "-H", sizes[i - 1][1] + "pt"] if i <= len(sizes) else ["-r", dpi]
                    run(["potrace", img, "-b", "pdf"] + size + ["-k", k, "-t", t, "-o", pp])
                    pdfs.append(pp)
                self.ui(self.bar.config, {"value": i})
                self.ui(self.say, "Page %d/%d done" % (i, len(pages)))
            if pdfs:
                vec = os.path.join(tmp, "all_vector.pdf")
                run(["pdfunite"] + pdfs + [vec])
                if self.make_pdf.get():
                    shutil.copy(vec, os.path.join(out, base + "_vector.pdf"))
                if self.overlay.get():
                    self.ui(self.say, "Overlaying vector on original…")
                    dst = os.path.join(out, base + "_original_plus_vector.pdf")
                    r = subprocess.run(["qpdf", pdf, "--overlay", vec, "--", dst],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    if r.returncode not in (0, 3):  # 3 = warnings only
                        raise RuntimeError("qpdf: " + r.stderr.decode(errors="ignore"))
            shutil.rmtree(tmp, ignore_errors=True)
            self.ui(self.say, "DONE → " + out)
            self.ui(lambda: subprocess.Popen(["xdg-open", out]))
        except subprocess.CalledProcessError as e:
            self.ui(self.say, "Error: " + e.stderr.decode(errors="ignore"))
        except Exception as e:
            self.ui(self.say, "Error: %s" % e)
        finally:
            self.ui(self.btn.state, ["!disabled"])


if __name__ == "__main__":
    App(sys.argv[1] if len(sys.argv) > 1 else None).mainloop()
