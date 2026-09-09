export const expenses = [
  { id: "e1", date: "09 Sep", merchant: "Corner Deli", project: "Acme launch", tax: "Meals · 50%", status: "Reviewed", amount: "$12.34" },
  { id: "e2", date: "08 Sep", merchant: "Euro Supplier", project: "—", tax: "Advertising", status: "Foreign excluded", amount: "€200.00" },
  { id: "e3", date: "06 Sep", merchant: "Staples", project: "Client refresh", tax: "Unreviewed", status: "Needs review", amount: "$100.00" },
];
export const report = {
  gross: "$162.34", deductible: "$106.17", ready: 143, review: 7,
  categories: [{ name: "Meals", value: "$6.17" }, { name: "Advertising", value: "$100.00" }, { name: "Uncategorized", value: "1 missing" }],
};
export function filterExpenses(query: string) {
  const normalized = query.trim().toLowerCase();
  return normalized ? expenses.filter((expense) => Object.values(expense).some((value) => value.toLowerCase().includes(normalized))) : expenses;
}
