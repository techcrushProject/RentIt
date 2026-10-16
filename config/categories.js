/**
 * Static catalogue. The names are copied verbatim from the onboarding screens
 * (renter interest buttons and the owner's equipment category select), so a
 * category saved by either flow is the same string. The slug doubles as the
 * stable id: it must never change once published.
 */
const category = (name, slug) => Object.freeze({ id: slug, name, slug });

export const CATEGORIES = Object.freeze([
    category("Equipments", "equipments"),
    category("Power Tools", "power-tools"),
    category("Properties", "properties"),
    category("Camera & Photography", "camera-photography"),
    category("Event & Party Items", "event-party-items"),
    category("Electronics", "electronics"),
    category("Furnitures", "furnitures"),
    category("More", "more"),
]);

/** Look a catalogue entry up by id, slug or name (case-insensitive). `value` must already be a string. */
export function findCategory(value) {
    const key = value.trim().toLowerCase();
    return CATEGORIES.find((entry) => entry.slug === key || entry.name.toLowerCase() === key);
}
