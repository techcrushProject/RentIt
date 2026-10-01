import mongoose from "mongoose";

const { Schema, model, models } = mongoose;


const ratingSchema = new Schema(
  {
    // A successful Rental transaction being reviewed
    // rental: {
    //   type: Schema.Types.ObjectId,
    //   ref: "Rental",
    //   required: true,
    //   index: true,
    // },

    // Person submitting the review after successfully completing a rental lifecycle
    // reviewer: {
    //   type: Schema.Types.ObjectId,
    //   ref: "User",
    //   required: true,
    //   index: true,
    // },

    // Owner receiving the review
    // reviewee: {
    //   type: Schema.Types.ObjectId,
    //   ref: "User",
    //   required: true,
    //   index: true,
    // },

    // Equipment associated with the rental
    // equipment: {
    //   type: Schema.Types.ObjectId,
    //   ref: "Equipment",
    //   default: null,
    //   index: true,
    // },

    // Direction of the review
    reviewType: {
      type: String,
      enum: ["renter_to_owner", "owner_to_renter"],
      required: true,
    },

     communication: {
      type: Number,
      min: 1,
      max: 5,
    },

    reliability: {
      type: Number,
      min: 1,
      max: 5,
    },

    equipmentCondition: {
      type: Number,
      min: 1,
      max: 5,
    },

    
    // Overall rating supplied by the reviewer
    overallRating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },

   

    // Written feedback
    comment: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },

    // Indicates that the review relates to a completed rental
    // isVerifiedRental: {
    //   type: Boolean,
    //   default: false,
    // },

    // Moderation status
    status: {
      type: String,
      enum: ["pending", "published", "hidden", "rejected"],
      default: "pending",
      index: true,
    },

  },
  {
    timestamps: true
  }
);

const Rating = mongoose.model("Rating", ratingSchema);


export default Rating;