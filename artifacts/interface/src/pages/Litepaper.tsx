import { Link } from "wouter";
import { ArrowLeft, Download } from "lucide-react";
import logo from "@assets/logo.png";
import logoWhite from "@assets/logo-white.png";
import { useTheme } from "@/theme";

const PDF_URL = `${import.meta.env.BASE_URL}bunny-litepaper.pdf`;

export default function Litepaper() {
  const { theme } = useTheme();
  const mark = theme === "dark" ? logoWhite : logo;

  return (
    <div className="h-full w-full flex flex-col bg-background text-foreground">
      <header className="shrink-0 flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors font-mono text-sm"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">home</span>
          </Link>
          <span className="h-4 w-px bg-border shrink-0" />
          <img src={mark} alt="bunnyOS" className="h-5 w-auto shrink-0" />
          <span className="font-mono text-sm text-muted-foreground truncate">
            litepaper
          </span>
        </div>
        <a
          href={PDF_URL}
          download
          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 font-mono text-xs text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">download</span>
        </a>
      </header>

      <div className="flex-1 min-h-0 w-full">
        <object
          data={PDF_URL}
          type="application/pdf"
          className="h-full w-full"
          aria-label="bunnyOS Litepaper"
        >
          <iframe
            src={PDF_URL}
            title="bunnyOS Litepaper"
            className="h-full w-full border-0"
          />
          <div className="flex h-full w-full items-center justify-center p-8 text-center">
            <p className="font-mono text-sm text-muted-foreground">
              your browser can't display the pdf inline.{" "}
              <a
                href={PDF_URL}
                download
                className="text-foreground underline underline-offset-4"
              >
                download the litepaper
              </a>
              .
            </p>
          </div>
        </object>
      </div>
    </div>
  );
}
