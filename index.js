const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

app.use(express.json());
app.use(cors());

mongoose.connect('mongodb+srv://jomilojuogunsola123_db_user:Israel007@cluster0.dgzbq4f.mongodb.net/Cohort8_db?appName=Cluster0')
    .then(() => {
        console.log('MongoDB connected successfully');
    })
    .catch((error) => {
        console.log('MongoDB connection failed:', error.message);
    });

app.get('/', (req, res) => {
    res.send('RentIt Backend is running');
});

const PORT = 3333;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});