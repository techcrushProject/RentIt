const ONE_DAY_IN_MS = 1000 * 60 * 60 * 24;

export const parseDate = (dateString) => {
  return new Date(dateString);
};

export const isValidDate = (date) => {
  return date instanceof Date && !Number.isNaN(date.getTime());
};

export const getTodayUTC = () => {
  const now = new Date();

  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    )
  );
};

export const validateDateRange = (startDate, endDate) => {
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return {
      valid: false,
      message: "Invalid start date or end date",
    };
  }

  const today = getTodayUTC();

  if (startDate < today) {
    return {
      valid: false,
      message: "Start date cannot be in the past",
    };
  }

  if (endDate < startDate) {
    return {
      valid: false,
      message: "End date cannot be before start date",
    };
  }

  return {
    valid: true,
  };
};

export const calculateRentalDays = (startDate, endDate) => {
  const difference = endDate.getTime() - startDate.getTime();

  return Math.floor(difference / ONE_DAY_IN_MS) + 1;
};

export const datesOverlap = (
  existingStart,
  existingEnd,
  requestedStart,
  requestedEnd
) => {
  return (
    existingStart <= requestedEnd &&
    existingEnd >= requestedStart
  );
};