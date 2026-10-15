
"use strict";

const API_BASE_URL="http://localhost:5000/api";
const USE_MOCK_DATA=true;
const MOCK_FAILURE_TEST=new URLSearchParams(window.location.search).get("simulateFailure")==="1";

const STEP1_KEY="renthub_add_equipment_draft";
const STEP2_KEY="renthub_add_equipment_step2";
const DRAFT_ID_KEY="renthub_equipment_draft_id";
const EQUIPMENT_KEY="renthub_added_equipment";

const $=selector=>document.querySelector(selector);

const state={
  equipment:null,
  images:[],
  imageIndex:0,
  loading:false,
  submitted:false,
  lastFocused:null
};

// API SERVICE
async function apiRequest(endpoint,options={}){
  const token=localStorage.getItem("ownerToken");
  const headers={...options.headers};

  if(token)headers.Authorization=`Bearer ${token}`;
  if(options.body&&!(options.body instanceof FormData)){
    headers["Content-Type"]="application/json";
  }

  let response;

  try{
    response=await fetch(`${API_BASE_URL}${endpoint}`,{
      ...options,
      headers
    });
  }catch{
    throw new Error("Unable to connect to the server. Check your network connection.");
  }

  if(!response.ok){
    const data=await response.json().catch(()=>({}));
    throw new Error(data.message||`Submission failed (HTTP ${response.status}).`);
  }

  if(response.status===204)return null;

  const contentType=response.headers.get("content-type")||"";
  return contentType.includes("application/json")
    ?response.json()
    :null;
}

// STORAGE HELPERS
function readJSON(storage,key){
  try{
    return JSON.parse(storage.getItem(key)||"null");
  }catch{
    return null;
  }
}

function getSavedEquipment(){
  const items=readJSON(localStorage,EQUIPMENT_KEY);
  return Array.isArray(items)?items:[];
}

function saveEquipment(equipment){
  const items=getSavedEquipment();
  const index=items.findIndex(item=>String(item.id)===String(equipment.id));

  if(index>=0)items[index]=equipment;
  else items.push(equipment);

  localStorage.setItem(EQUIPMENT_KEY,JSON.stringify(items));
}

function clearDraft(){
  sessionStorage.removeItem(STEP1_KEY);
  sessionStorage.removeItem(STEP2_KEY);
  sessionStorage.removeItem(DRAFT_ID_KEY);
}

function createId(){
  if(window.crypto?.randomUUID)return window.crypto.randomUUID();
  return `equipment-${Date.now()}-${Math.floor(Math.random()*1000000)}`;
}

// MOCK JSON
async function loadSample(){
  const response=await fetch("./listing-preview.json",{cache:"no-store"});

  if(!response.ok){
    throw new Error(`Unable to load listing-preview.json (${response.status}).`);
  }

  const data=await response.json();

  if(!data.equipment||typeof data.equipment!=="object"||Array.isArray(data.equipment)){
    throw new Error("The JSON file must contain an equipment object.");
  }

  return data.equipment;
}

// BUILD LISTING FROM PREVIOUS FORM STEPS
function buildDraft(step1,step2){
  const first=step1.equipment||step1;
  const second=step2.equipment||step2;

  return {
    id:sessionStorage.getItem(DRAFT_ID_KEY)||"local-draft",
    name:first.name||first.equipmentName||"Unnamed Equipment",
    category:first.category||"Not specified",
    brand:first.brand||first.brandName||"Not specified",
    model:first.model||"Not specified",
    description:first.description||"No description provided",
    condition:first.condition||"Not specified",
    location:second.location||second.address||"Not specified",
    availableStart:second.availableStart||second.availableFrom||"",
    availableEnd:second.availableEnd||second.availableTo||"",
    unavailableStart:second.unavailableStart||"",
    unavailableEnd:second.unavailableEnd||"",
    price:Number(second.rentalPrice??second.price??0),
    deposit:Number(second.rentalDeposit??second.deposit??0),
    handoverMethod:second.handoverMethod||"Not specified",
    images:Array.isArray(first.images)?first.images:[],
    owner:first.owner||null,
    status:"Drafts"
  };
}

// FETCH EQUIPMENT
async function getEquipment(){
  if(USE_MOCK_DATA){
    const step1=readJSON(sessionStorage,STEP1_KEY);
    const step2=readJSON(sessionStorage,STEP2_KEY);

    if(step1&&step2)return buildDraft(step1,step2);

    const sample=await loadSample();
    const saved=getSavedEquipment().find(item=>String(item.id)===String(sample.id));

    return saved?{...sample,...saved}:sample;
  }

  const id=sessionStorage.getItem(DRAFT_ID_KEY);

  if(!id){
    throw new Error("Equipment draft ID is missing. Complete the equipment forms first.");
  }

  const response=await apiRequest(`/owner/equipment/${encodeURIComponent(id)}`);
  return response?.equipment||response;
}

// FORMATTERS
function formatMoney(value){
  return new Intl.NumberFormat("en-NG",{
    style:"currency",
    currency:"NGN",
    maximumFractionDigits:0
  }).format(Number(value)||0);
}

function formatDate(value){
  if(!value)return "Not specified";

  const date=/^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ?new Date(`${value}T12:00:00`)
    :new Date(value);

  if(Number.isNaN(date.getTime()))return String(value);

  return date.toLocaleDateString("en-US",{
    month:"short",
    day:"numeric",
    year:"numeric"
  });
}

function showMessage(message,isError=false){
  const element=$("#actionMessage");
  element.textContent=message;
  element.className=`mt-3 block text-sm ${isError?"text-red-600":"text-green-700"}`;
}

// GALLERY
function getImages(item){
  if(Array.isArray(item.images)){
    const images=item.images.filter(src=>typeof src==="string"&&src.trim());
    if(images.length)return images;
  }

  if(typeof item.image==="string"&&item.image.trim())return [item.image];

  return ["./img/camera.png"];
}

function renderGallery(){
  const images=state.images;
  if(!images.length)return;

  state.imageIndex=(state.imageIndex+images.length)%images.length;

  $("#mainEquipmentImage").src=images[state.imageIndex];
  $("#mainEquipmentImage").alt=`${state.equipment.name}, image ${state.imageIndex+1}`;
  $("#imageCounter").textContent=`${state.imageIndex+1} / ${images.length}`;

  const thumbnails=$("#thumbnailList");
  thumbnails.replaceChildren();

  images.forEach((src,index)=>{
    const button=document.createElement("button");
    button.type="button";
    button.className=`overflow-hidden rounded-lg border-2 ${index===state.imageIndex?"border-[#214F79]":"border-transparent"}`;
    button.setAttribute("aria-label",`View image ${index+1}`);
    button.setAttribute("aria-pressed",String(index===state.imageIndex));

    const image=document.createElement("img");
    image.src=src;
    image.alt=`Equipment thumbnail ${index+1}`;
    image.loading="lazy";
    image.className="aspect-[1.35/1] w-full object-cover";

    button.appendChild(image);
    button.addEventListener("click",()=>{
      state.imageIndex=index;
      renderGallery();
    });

    thumbnails.appendChild(button);
  });

  const multiple=images.length>1;

  ["#previousImage","#nextImage"].forEach(selector=>{
    const button=$(selector);
    button.classList.toggle("hidden",!multiple);
    button.classList.toggle("flex",multiple);
  });
}

function moveImage(direction){
  if(!state.images.length)return;
  state.imageIndex=(state.imageIndex+direction+state.images.length)%state.images.length;
  renderGallery();
}

// DETAILS
function createDetailRow(label,value){
  const row=document.createElement("div");
  row.className="flex items-center justify-between gap-4 py-3 text-[15px] lg:py-2.5 lg:text-sm";

  const title=document.createElement("span");
  title.className="text-gray-500";
  title.textContent=label;

  const content=document.createElement("span");
  content.className="max-w-[62%] text-right font-semibold text-[#303030]";
  content.textContent=String(value??"Not specified");

  row.append(title,content);
  return row;
}

function renderEquipment(){
  const item=state.equipment;

  $("#equipmentName").textContent=item.name||"Unnamed Equipment";
  $("#equipmentLocation").textContent=item.location||"Not specified";
  $("#equipmentDescription").textContent=item.description||"No description provided";

  const price=`${formatMoney(item.price)}/day`;
  $("#desktopPrice").textContent=price;
  $("#mobilePrice").textContent=price;
  $("#availabilityText").textContent=`Available from ${formatDate(item.availableStart)}`;

  const owner=item.owner||{};
  $("#ownerName").textContent=owner.name||"Equipment Owner";
  $("#ownerRating").textContent=owner.rating??"0.0";
  $("#ownerReviews").textContent=`(${owner.reviews??0})`;
  $("#ownerImage").src=owner.image||"./img/profile.svg";

  const details=$("#equipmentDetails");
  details.replaceChildren();

  [
    ["Category",item.category||"Not specified"],
    ["Brand",item.brand||"Not specified"],
    ["Model",item.model||"Not specified"],
    ["Deposit",formatMoney(item.deposit)],
    ["Handover Method",item.handoverMethod||"Not specified"],
    ["Condition",item.condition||"Not specified"]
  ].forEach(([label,value])=>{
    details.appendChild(createDetailRow(label,value));
  });

  state.images=getImages(item);
  renderGallery();

  const submitted=["Submitted","Pending Review","Published","Available","Unavailable","In Use"].includes(item.status);
  state.submitted=submitted;

  const button=$("#submitListingButton");
  button.disabled=submitted;
  button.textContent=submitted?"Listing Already Submitted":"Submit Listing";
}

// AVAILABILITY
function openDates(){
  const item=state.equipment;
  const content=$("#datesContent");
  content.replaceChildren();

  [
    ["Available from",formatDate(item.availableStart)],
    ["Available until",formatDate(item.availableEnd)],
    ["Unavailable from",item.unavailableStart?formatDate(item.unavailableStart):"None"],
    ["Unavailable until",item.unavailableEnd?formatDate(item.unavailableEnd):"None"]
  ].forEach(([label,value])=>{
    content.appendChild(createDetailRow(label,value));
  });

  $("#datesDialog").classList.replace("hidden","flex");
  $("#closeDatesDialog").focus();
}

function closeDates(){
  $("#datesDialog").classList.replace("flex","hidden");
  $("#viewDatesButton").focus();
}

// MODAL CONTROLS
function openModal(selector){
  const modal=$(selector);
  state.lastFocused=document.activeElement;
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.classList.add("overflow-hidden");

  const closeButton=modal.querySelector('button[aria-label^="Close"]');
  closeButton?.focus();
}

function closeModal(selector){
  const modal=$(selector);
  modal.classList.remove("flex");
  modal.classList.add("hidden");
  document.body.classList.remove("overflow-hidden");
  state.lastFocused?.focus();
}

function closeSuccess(){
  closeModal("#successModal");
}

function closeFailure(){
  closeModal("#failureModal");
}

// MOCK SUBMISSION
async function submitMockListing(){
  if(MOCK_FAILURE_TEST){
    throw new Error("Simulated submission failure for testing.");
  }

  const item=state.equipment;

  const submitted={
    ...item,
    id:item.id==="local-draft"?createId():item.id,
    status:"Submitted",
    image:state.images[0]||"./img/camera.png",
    images:[...state.images],
    submittedAt:new Date().toISOString()
  };

  saveEquipment(submitted);
  clearDraft();

  return submitted;
}

// REAL BACKEND SUBMISSION
async function submitBackendListing(){
  const item=state.equipment;

  if(!item?.id)throw new Error("Equipment ID is missing.");

  const response=await apiRequest(
    `/owner/equipment/${encodeURIComponent(item.id)}/submit`,
    {method:"POST"}
  );

  if(!response||typeof response!=="object"){
    throw new Error("The server did not confirm the listing submission.");
  }

  const submitted=response.equipment||response;

  if(!submitted.id||!["Submitted","Pending Review","Published"].includes(submitted.status)){
    throw new Error("The server did not return a confirmed submission status.");
  }

  clearDraft();
  return submitted;
}

// SUBMISSION HANDLER
async function handleSubmit(){
  if(state.loading||state.submitted||!state.equipment)return;

  const button=$("#submitListingButton");
  state.loading=true;
  button.disabled=true;
  button.textContent="Submitting...";
  $("#actionMessage").classList.add("hidden");

  try{
    const submitted=USE_MOCK_DATA
      ?await submitMockListing()
      :await submitBackendListing();

    state.equipment=submitted;
    state.submitted=true;
    button.disabled=true;
    button.textContent="Listing Submitted";

    openModal("#successModal");
  }catch(error){
    console.error("Equipment submission failed:",error);

    showMessage(error.message||"Unable to submit equipment.",true);

    $("#failureDescription").textContent=
      "Your equipment submission failed. Check your network connection and try again.";

    button.disabled=false;
    button.textContent="Submit Listing";

    openModal("#failureModal");
  }finally{
    state.loading=false;
  }
}

// RETRY
function retrySubmission(){
  closeFailure();
  handleSubmit();
}

// LOGOUT
async function logout(){
  if(!USE_MOCK_DATA){
    await apiRequest("/auth/logout",{method:"POST"});
  }

  localStorage.removeItem("ownerToken");
  window.location.href="../login.html";
}

// INITIALIZATION
async function initialize(){
  $("#previousImage").addEventListener("click",()=>moveImage(-1));
  $("#nextImage").addEventListener("click",()=>moveImage(1));

  $("#viewDatesButton").addEventListener("click",openDates);
  $("#closeDatesDialog").addEventListener("click",closeDates);

  $("#datesDialog").addEventListener("click",event=>{
    if(event.target===event.currentTarget)closeDates();
  });

  $("#submitListingButton").addEventListener("click",handleSubmit);
  $("#retrySubmissionButton").addEventListener("click",retrySubmission);

  $("#closeSuccessModal").addEventListener("click",closeSuccess);
  $("#closeFailureModal").addEventListener("click",closeFailure);
  $("#backFromFailureButton").addEventListener("click",closeFailure);

  $("#addAnotherButton").addEventListener("click",clearDraft);

  document.addEventListener("keydown",event=>{
    if(event.key==="Escape"){
      if(!$("#failureModal").classList.contains("hidden"))closeFailure();
      else if(!$("#successModal").classList.contains("hidden"))closeSuccess();
      else if(!$("#datesDialog").classList.contains("hidden"))closeDates();
    }
  });

  $("#logoutButton").addEventListener("click",()=>{
    logout().catch(error=>showMessage(error.message,true));
  });

  try{
    state.equipment=await getEquipment();

    if(!state.equipment||typeof state.equipment!=="object"){
      throw new Error("Invalid equipment information.");
    }

    renderEquipment();
  }catch(error){
    console.error("Preview loading failed:",error);
    $("#equipmentName").textContent="Equipment unavailable";
    $("#submitListingButton").disabled=true;
    showMessage(error.message,true);
  }
}

document.addEventListener("DOMContentLoaded",initialize);
