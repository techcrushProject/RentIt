import Equipment from "../Models/equipment.js";

export const createEquipment = async (req, res) => {
    try {
        const { title, description, price, category, condition, location, specs, image } = req.body;
        const numericPrice = Number(price);

        if (!title || title.trim().length < 3 || !Number.isFinite(numericPrice) || numericPrice <= 0) {
            return res.status(400).json({ message: "A title of at least 3 characters and a positive price are required" });
        }

        const equipment = await Equipment.create({
            title: title.trim(),
            description: String(description || "").trim(),
            price: numericPrice,
            category: String(category || "").trim(),
            condition: String(condition || "").trim(),
            location: String(location || "").trim(),
            specs: Array.isArray(specs) ? specs.map(value => String(value).trim()).filter(Boolean) : [],
            image: image || "",
            owner: req.user.id
        });

        return res.status(201).json({ message: "Equipment listing created", equipment });
    } catch (error) {
        return res.status(500).json({ message: "Server error while creating equipment listing" });
    }
};