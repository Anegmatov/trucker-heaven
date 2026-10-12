"""Create transparent crops from the immutable approved Trucker Heaven logo."""

from hashlib import sha256
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


REPOSITORY = Path(__file__).resolve().parents[2]
BRAND_DIRECTORY = REPOSITORY / "public" / "brand"
MASTER = BRAND_DIRECTORY / "trucker-heaven-logo-master.jpg"
EXPECTED_MASTER_SHA256 = "1f266c4d8cc0457a8d4ea6421f2b2fb4d71b933a3d6e55019026e9effcb4d178"


def padded_box(box, size, padding=28):
    left, top, right, bottom = box
    width, height = size
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(width, right + padding),
        min(height, bottom + padding),
    )


def transparent_logo():
    if sha256(MASTER.read_bytes()).hexdigest() != EXPECTED_MASTER_SHA256:
        raise RuntimeError("The approved master logo changed; refusing to regenerate derivatives.")

    source = Image.open(MASTER).convert("RGB")
    keyed = source.copy()
    key_color = (255, 0, 255)
    ImageDraw.floodfill(keyed, (0, 0), key_color, thresh=55)

    background = Image.new("L", source.size, 0)
    flattened = keyed.get_flattened_data() if hasattr(keyed, "get_flattened_data") else keyed.getdata()
    background.putdata([255 if pixel == key_color else 0 for pixel in flattened])
    edge_band = background.filter(ImageFilter.MaxFilter(9))

    output = Image.new("RGBA", source.size)
    source_pixels = source.load()
    background_pixels = background.load()
    edge_pixels = edge_band.load()
    output_pixels = output.load()

    for y in range(source.height):
        for x in range(source.width):
            red, green, blue = source_pixels[x, y]
            if background_pixels[x, y]:
                output_pixels[x, y] = (0, 0, 0, 0)
                continue

            alpha = 255
            if edge_pixels[x, y]:
                alpha = max(255 - red, 255 - green, 255 - blue)
                alpha = max(1, min(255, alpha))
                red = round(255 + (red - 255) * 255 / alpha)
                green = round(255 + (green - 255) * 255 / alpha)
                blue = round(255 + (blue - 255) * 255 / alpha)
            output_pixels[x, y] = (
                max(0, min(255, red)),
                max(0, min(255, green)),
                max(0, min(255, blue)),
                alpha,
            )

    alpha = output.getchannel("A")
    full_box = padded_box(alpha.getbbox(), output.size)
    full = output.crop(full_box)

    nav_region = alpha.crop((0, 0, output.width, 408))
    nav_box = padded_box(nav_region.getbbox(), (output.width, 408))
    nav = output.crop(nav_box)

    full.save(BRAND_DIRECTORY / "trucker-heaven-logo-full.png", optimize=True)
    nav.save(BRAND_DIRECTORY / "trucker-heaven-logo-nav.png", optimize=True)

    print(f"Created full logo {full.size} and nav logo {nav.size} from the approved master.")


if __name__ == "__main__":
    transparent_logo()
