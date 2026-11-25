# Homebrew formula for termbrowse. It lives in the tap repository
# matthewalunni/homebrew-tap as Formula/termbrowse.rb; this copy is the source of truth.
# After each npm release, update `url` and `sha256` (see packaging/homebrew/README.md).
class Termbrowse < Formula
  desc "Chrome in your terminal via Kitty graphics, plus one Chrome per AI agent"
  homepage "https://github.com/matthewalunni/termbrowse"
  url "https://registry.npmjs.org/termbrowse/-/termbrowse-0.1.1.tgz"
  sha256 "24f55376aa5d385c24ad5227b617be849bddc3805d20505b671a1a4332358c27"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      Chrome for Testing (about 150 MB) downloads to ~/.cache/termbrowse the first time
      termbrowse needs a browser. Check your setup with:
        termbrowse doctor
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/termbrowse --version")
    # Loads the CLI, config and state code with Homebrew's Node; needs no Chrome.
    assert_equal "[]", shell_output("#{bin}/termbrowse agents --json").strip
  end
end
