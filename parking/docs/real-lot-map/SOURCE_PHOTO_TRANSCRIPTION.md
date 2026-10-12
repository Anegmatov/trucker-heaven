# Source-photo transcription

Authoritative photo inspected: `/mnt/c/Users/azizb/Downloads/Telegram Desktop/photo_2026-07-29_11-46-46.jpg` (1920 × 2560 JPEG). This is a portrait printed Trucker Heaven site plan with handwritten operational annotations. Geometry below is transcribed into normalized coordinates in `backend/data/trucker-heaven-real-lot-layout.v1.json`; handwriting is not treated as automatic booking configuration.

## Confirmed physical facts

| Physical group | Observed arrangement and numbering | Digital representation |
| --- | --- | --- |
| West exterior, north | Horizontal stacked exterior bays labelled `168` through `196`, increasing top to bottom. | West north exterior row. |
| West exterior, middle | Separate horizontal stacked run `60` through `72`, below the north run and beside a printed BOBTAIL label. | West middle bobtail row. |
| West exterior, lower | Short horizontal stacked group `90` down to `85`. | West Shop row. |
| Upper-center bobtail | Two parallel horizontal-stall columns under a printed BOBTAIL label. West column increases `37` to `59` downward; east column decreases `36` to `14` downward. | Paired upper-center bobtail rows. |
| Upper-center small bays | Four short vertical bays, `10` through `13`, below the paired bobtail columns. | Upper-center small bays. |
| Middle center | Eight tall vertical bays `197`–`204`, immediately above eight tall vertical bays `73`–`80`. | Stacked middle-center groups with an explicit clear separation. |
| Lower middle | Four tall vertical bays `84` to `81` below the main building. | Lower-middle Shop row. |
| East exterior, upper/middle | Long horizontal-stall perimeter runs. The legible sequence is `165`–`167`, then `164` down to `143`, then `142` down to `111`; two pill-shaped islands interrupt the perimeter presentation. | Three East exterior groups and two islands. |
| East exterior, lower | Short horizontal-stall group `110` down to `101`. | Company / ITM row. |
| Buildings and circulation | A small north Trucker Heaven/office footprint, a broad central Trucker Heaven building complex, a west-side structure, and a larger lower service structure. Open central and perimeter circulation remain between the parking groups. | Vector BUILDING and DRIVE_LANE elements, not a raster background. |

Spaces `91`–`100` do not appear in the physical numbering sequence and remain excluded.

## Confirmed owner classifications

- `85`–`90`: Shop.
- `101`–`110`: Company / ITM.
- The lower-middle spaces below the main building: Shop.
- `73`–`80`: physically bobtail bays, but the Shop Bobtail / Customer Bobtail split remains unresolved.

## Handwriting recorded, not promoted to booking rules

- “Monthly” appears by exterior groups and near the north portion of the map.
- “Daily” appears by the right perimeter and near the main building.
- “Shop”, “Company”, and “Bobtail” are marked in several areas; the clearly owner-confirmed subsets above are the only durable classifications applied.
- Green/red/black check marks and special-rate notes are operational annotations, not physical-space status or availability data.
- Direction arrows appear along both perimeter drives. They establish that perimeter circulation exists, but exact one-way routing remains operationally unresolved.

## Photo limitations / unresolved physical interpretation

- Glare partially obscures the upper-right perimeter immediately around `165`–`167` and several handwritten marks.
- The exact curb, bollard, and barrier dimensions cannot be measured from the oblique photograph; they are represented as proportional vector obstacles.
- The photo does not resolve the business split of `73`–`80`; they remain `NEEDS_CLASSIFICATION`, internal, non-public, and non-assignable.
