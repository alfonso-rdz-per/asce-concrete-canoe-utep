# Marca y imágenes (`public/brand/`)

Logos (aportados por el equipo; la composición siempre es `ASCE | UTEP`, nunca se inventan ni se generan):

| Archivo | Uso |
|---|---|
| `asce-logo.png` · `asce-logo-white.png` | Logo de ASCE sobre fondos claros / oscuros (navy) |
| `utep-logo.svg` · `utep-logo-white.png` | Logo de UTEP sobre fondos claros / oscuros (navy) |

`BrandMark` (`src/components/brand/BrandMark.tsx`) los usa solos según `src/lib/brand/assets.ts`. Si falta alguno, muestra un marcador rotulado.

Imágenes del diseño Concrete Canoe (aportadas por el equipo, **se usan tal cual, sin modificar los archivos**):

| Archivo | Uso |
|---|---|
| `canoe-draw.png` | Ilustración de la canoa (PNG con transparencia, 1023×700). Se sirve sin recodificar en la franja clara bajo las olas (`CanoeBand`) y como marca de agua blanca en la tarjeta "Start Check-In" del panel |
| `imagen-fondo.jpg` | Foto de fondo de la portada y del check-in del estudiante. El tratamiento azul es solo CSS (`.hero-photo` en `globals.css`: mezcla de fondo `luminosity` sobre navy + degradados en `HeroBackdrop`). Nota: el archivo aportado es en realidad WebP con extensión `.jpg`; los navegadores lo detectan por su contenido |
