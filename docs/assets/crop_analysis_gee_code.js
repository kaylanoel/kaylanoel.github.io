var image = ee.Image("projects/ee-knparamore/assets/vasylivskyi_rapeed_class1_2_NDis999"),
    geometry = /* color: #d63000 */ee.Geometry.Point([35.0274937578483, 47.35804176552162]),
    table = ee.FeatureCollection("projects/ee-knparamore/assets/vasylivskyi_no_water_v5"),
    geometry2 = 
    /* color: #fefefe */
    /* displayProperties: [
      {
        "type": "rectangle"
      }
    ] */
    ee.Geometry.Polygon(
        [[[34.0881627031608, 47.769473454357794],
          [34.0881627031608, 46.702819505292965],
          [35.9558384844108, 46.702819505292965],
          [35.9558384844108, 47.769473454357794]]], null, false);

var eurocropMask = image;
var roi = table.geometry();
var scene = geometry
var outline = ee.Image().byte().paint({
  featureCollection: roi,
  color:1,
  width: 3
})

var startMonth = 5        
var endMonth = 5
var bandList = [
  "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B8A", "B9", "B11", "B12", 
  "NDVI", "NDYI"
]

var rgbViz = {
  min: 0.0,
  max: 0.3,
  bands: ['B4', 'B3', 'B2'],
  };
  
var classifiedViz = 
  {min:0, 
  max:1, 
  palette: ['#5f5c81', '#e8b800']
  };

// Cloud mask
// New cloud mask that uses SCL instead of QA60
function maskS2clouds(image) {
  var scl = image.select('SCL');
  var timeStart = image.get('system:time_start');
  // SCL classes to remove: 3=cloud shadow, 8=cloud medium prob, 9=cloud high prob, 10=cirrus, 11=snow
  var mask = scl.neq(3).and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
  return image.updateMask(mask).divide(10000).set('system:time_start', timeStart);
}

// NDVI function
  function addNDVI(image) {
  var ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI');
    return image.addBands(ndvi);
  }
  
// Normalized Difference Yellowness Index (NDYI) function
  function addNDYI(image) {
  var ndyi = image.normalizedDifference(['B3', 'B2']).rename('NDYI');
    return image.addBands(ndyi);
  }

Map.addLayer(geometry2,{color: 'white'},'background');


//-------||-------||-------||-------||PART 1        ||-------||-------||-------||-------||
//-------||-------||-------||-------||Train RF Model||-------||-------||-------||-------||



var s2May2022 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
                  .filterDate('2022-01-01', '2022-12-31')
                  .filter(ee.Filter.calendarRange(startMonth, endMonth, 'month'))
                  .filterBounds(roi)
                  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE',20))
                  .map(maskS2clouds)
                  .map(addNDVI)
                  .map(addNDYI)
                  .select(bandList)
                  ;
                  

print("May 2022 Collection",s2May2022)

// Single mean image
var may2022 = s2May2022.mean()

//Classification
//https://www.youtube.com/watch?v=vQTknTHLtUQ
//1: rapeseed
//0: other

//get training samples
var samples = eurocropMask.stratifiedSample({
  numPoints: 200,
  classBand: 'b1',
  region: roi,
  scale: 10,
  geometries: true 
});

print('samples', samples)

var samples = samples.select(['b1'], ['landcover']);    // rename the property with the class
var samples = samples.map(function(f) {
  return f.set('landcover', ee.Number(f.get('landcover')).eq(1));   //recode to 1 and 0 bc RF adds a 0 class if you don't
});
print('samples renamed', samples)

var gcps = samples;    //gcps stands for ground control points

//Model with 60/40 split and accuracy assesment
print('total samples', gcps.size())
//60% for training, 40% for validation
gcps = gcps.randomColumn()                     // add a random number property
var trainingGcps = gcps.filter(ee.Filter.lt('random',0.6));
var validationGcps = gcps.filter(ee.Filter.gte('random',0.6));

print('training sample size', trainingGcps.size())
print('validation sample size', validationGcps.size())

//Add the image band data to the training samples
var training_data = may2022.sampleRegions({
  collection:trainingGcps,
  properties:['landcover'], 
  scale: 10
  });
print('training data', training_data);

//Train the model 
var rfModel = ee.Classifier.smileRandomForest(50).train({
  features: training_data, 
  classProperty: 'landcover', 
  inputProperties: bandList
});


//-------||-------||-------||PART 2                       ||-------||-------||-------||-------||
//-------||-------||-------||Classify 2019-2025 May Images||-------||-------||-------||-------||


// Function to apply the model to all years
var classifyYear = function(year) {
  var startDate = ee.Date.fromYMD(year, 1, 1);
  var endDate = ee.Date.fromYMD(year, 12, 31);
  
  var s2MayCol = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
                  .filterDate(startDate, endDate)
                  .filter(ee.Filter.calendarRange(startMonth, endMonth, 'month'))
                  .filterBounds(roi)
                  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
                  .map(maskS2clouds)
                  .map(addNDVI)
                  .map(addNDYI)
                  .select(bandList);

  // Calculate mean May image
  var meanMayImg = s2MayCol.mean()
  
  // Calculate filler image
  var s2JunCol = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
                .filterDate(startDate, endDate)
                .filter(ee.Filter.calendarRange(6, 6, 'month'))
                .filterBounds(roi)
                .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
                .map(maskS2clouds)
                .map(addNDVI)
                .map(addNDYI)
                .select(bandList);
  
  // Calculate mean June image
  var meanJunImg = s2JunCol.mean()
  
  // Fill the missing pixels
  var meanImg = meanMayImg.unmask(meanJunImg, false);
  
  // Classify the image
  var classifiedImg = meanImg.classify(rfModel).clip(roi);

  // Calculate statistics on the image and add them as a property
  // Get rapeseed pixel count
  var stats = classifiedImg.reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: roi,
    scale: 10, 
    maxPixels: 1e13
  });
  
  // Reformat the stats result as a number
  var pixelCount = stats.getNumber('classification');
  // Calculate hectacres
  var hectares = pixelCount.multiply(0.01);

  // Add properties to the image
  classifiedImg = classifiedImg.set({
    'year': year,
    'rapeseed_pixel_count': pixelCount,
    'rapeseed_hectacres': hectares
  });

  // Export to Asset
  Export.image.toAsset({
    image: classifiedImg,
    description: 'Classified_Rapeseed_Map_' + year,
    scale: 10,
    region: roi,
    maxPixels: 1e13
  });
  
  //print('May Collection' + year, s2Col);


  Map.addLayer(meanImg, rgbViz, 'RGB May ' + year, false);
  Map.addLayer(classifiedImg, classifiedViz, 'Classification ' + year, false )
  
  return classifiedImg;
};
  

// Define the years
var years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];


//years.forEach(classifyYear);
//Execute for each year and save as an image collection
var classifiedImages = years.map(classifyYear);
var classifiedCollection = ee.ImageCollection.fromImages(classifiedImages);
print('Classified Collection', classifiedCollection)

//-------||-------||-------||PART 3                                     ||-------||-------||-------||-------||
//-------||-------||-------||Evaluate Model Based on 2022 Classification||-------||-------||-------||-------||

// //get the 2022 classified map
// var classified2022 = classifiedCollection.filter(ee.Filter.eq('year', 2022)).first();

// print('2022 Classified', classified2022)

// //Accuracy Assesment of Model
// //Create the collection with both the classification and the result
// var validation = classified2022.sampleRegions({
//   collection: validationGcps,
//   properties: ['landcover'],
//   scale: 10
// })
// print('validation dataset', validation)

// var confusionMatrix = validation.errorMatrix('landcover','classification');
// print(confusionMatrix)
// print("Accuracy", confusionMatrix.accuracy())
// print("Kappa", confusionMatrix.kappa())


//-------||-------||-------||PART 4                                      ||-------||-------||-------||-------||
//-------||-------||-------||Create NDVI and NDYI Timeseries for Each Year||-------||-------||-------||-------||


// // //------------------------- NDVI Function-------------------------
// var printNDVIchart = function(year) {
  
//   // Get mask for the year
//   var classification = classifiedCollection.filter(ee.Filter.eq('year', year)).first();
  
//   //function apply to the classificaion as a mask
//   function rapeseedmask(image){
//   return image.updateMask(classification)
// }
  
//   // Get filtered collection for the year
//   var startDate = ee.Date.fromYMD(year, 1, 1);
//   var endDate = ee.Date.fromYMD(year, 12, 31);
  
//   var s2Col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
//                   .filterDate(startDate, endDate)
//                   .filterBounds(scene)
//                   .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
//                   .map(maskS2clouds)
//                   .map(addNDVI)
//                   .map(addNDYI)
//                   .map(rapeseedmask)
//                   .select("B2", "B3", "B4", "NDVI", "NDYI");

  
//   Map.addLayer(s2Col.median(), rgbViz, 'RGB Rapeseed Yr Med ' + year, false);
  
//   var chart = ui.Chart.image.seriesByRegion({
//     imageCollection: s2Col.select(['NDVI', 'NDYI']),
//     regions: roi,
//     reducer: ee.Reducer.mean(),
//     scale: 30
//   })
//   .setOptions({
//     title: 'NDVI for Rapeseed ' + year,
//     vAxis: {title: 'Index Value',  viewWindow: {min: 0,max: 1}},
//     hAxis: {title: 'Date', 
//       format: 'MMM', 
//       gridlines: {count: 6},
      
//     },
//     lineWidth: 2,
//     pointSize: 3,
//     series: {
//       0: {color: '00FF00', labelInLegend: 'NDVI'}, // Green
//       1: {color: 'yellow', labelInLegend: 'NDYI'}   // Yellow
//     }
//   });
  
//   print(chart);
//   }

// //Execute the function
// years.forEach(printNDVIchart)


//-------------------------NDYI Function-----------------------------
// var printNDYIchart = function(year) {
  
//   // Get mask for the year
//   var classification = classifiedCollection.filter(ee.Filter.eq('year', year)).first();
  
//   //function apply to the classificaion as a mask
//   function rapeseedmask(image){
//   return image.updateMask(classification)
// }
  
//   // Get filtered collection for the year
//   var startDate = ee.Date.fromYMD(year, 1, 1);
//   var endDate = ee.Date.fromYMD(year, 12, 31);
  
//   var s2Col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
//                   .filterDate(startDate, endDate)
//                   .filterBounds(scene)
//                   .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
//                   .map(maskS2clouds)
//                   .map(addNDVI)
//                   .map(addNDYI)
//                   .map(rapeseedmask)
//                   .select("B2", "B3", "B4", "NDVI", "NDYI");

//   var chart = ui.Chart.image.seriesByRegion({
//     imageCollection: s2Col.select(['NDYI']),
//     regions: roi,
//     reducer: ee.Reducer.mean(),
//     scale: 30
//   })
//   .setOptions({
//     title: 'NDYI for Rapeseed ' + year,
//     vAxis: {title: 'Index Value'},   //viewWindow: {min: 0,max: 0.075}
//     hAxis: {title: 'Date', 
//       format: 'MMM', 
//       gridlines: {count: 6},
      
//     },
//     lineWidth: 2,
//     pointSize: 3,
//     series: {
//       0: {color: 'yellow', labelInLegend: 'NDYI'}, // Yellow
//     }
//   });
  
//   print(chart);
//   }

// //Execute the function
// years.forEach(printNDYIchart)

//-------||-------||-------||-------||PART 4       ||-------||-------||-------||-------||
//-------||-------||-------||-------||Smoothing||-------||-------||-------||-------||

// //-----------------------Method 1 -  Moving Average ---------------------------------------//

// var printNDYIandMovingAvg = function(year,window) {
//   // Get 1 year masked collection
//   var classification = classifiedCollection.filter(ee.Filter.eq('year', year)).first();
    
//   //function apply to the classificaion as a mask
//   function rapeseedmask(image){
//     return image.updateMask(classification)
//   }
    
//   // Get filtered collection for the year
//   var startDate = ee.Date.fromYMD(year, 1, 1);
//   var endDate = ee.Date.fromYMD(year, 12, 31);
  
//   var s2ColNDYI = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
//                   .filterDate(startDate, endDate)
//                   .filterBounds(scene)
//                   .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
//                   .map(maskS2clouds)
//                   .map(addNDVI)
//                   .map(addNDYI)
//                   .map(rapeseedmask)
//                   .select("B2", "B3", "B4", "NDVI", "NDYI");
  
//   print(year + ' NDYI Coll', s2ColNDYI)
  
//   // Time window
//   var days = window
  
//   // Join all the images within the time window
//   var join = ee.Join.saveAll({
//     matchesKey: 'images'
//   });
  
//   // Match all the images within the day range
//   var diffFilter = ee.Filter.maxDifference({
//     difference: 1000 * 60 * 60 * 24 * days,
//     leftField: 'system:time_start',
//     rightField: 'system:time_start'
//   });
  
//   // Select NDYI
//   var ndyiCol = s2ColNDYI.select('NDYI')
  
//   var joinedCollection = join.apply({
//     primary: ndyiCol,
//     secondary: ndyiCol,
//     condition: diffFilter
//   });
  
//   var smoothedCollection = ee.ImageCollection(joinedCollection.map(function(image){
//     var collection = ee.ImageCollection.fromImages(image.get('images'));
//     return ee.Image(image).addBands(collection.mean().rename('moving_average'));
//   }))
  
//   // Chart original 
//   var chart = ui.Chart.image.seriesByRegion({
//     imageCollection: smoothedCollection.select('NDYI','moving_average'),
//     regions: roi,
//     reducer: ee.Reducer.mean(),
//     scale: 20
//   }).setOptions({
//       lineWidth:1,
//       title: 'NDYI Timeseries ' + year ,
//       interpolateNulls: true,
//       vAxis: {title:'NDYI'},
//       hAxis: {title:'',format:'MMM'},
//       series:{
//         1:{color: 'grey', lineDashStyle: [1, 1]},
//         0:{color: 'yellow', lineWidth: 2},
//       },
      
//   })
//   print(chart);
  
//   // Chart smoothed
//   var chart = ui.Chart.image.seriesByRegion({
//     imageCollection: smoothedCollection.select('moving_average'),
//     regions: roi,
//     reducer: ee.Reducer.mean(),
//     scale: 20
//   }).setOptions({
//       lineWidth:1,
//       title: 'NDYI Timeseries Moving Average ' + year,
//       interpolateNulls: true,
//       vAxis: {title:'NDYI'},
//       hAxis: {title:'',format:'MMM'},
//       series:{
//         0:{color: 'grey', lineDashStyle: [1, 1]}
//       },
      
//   })
//   print(chart);

// }

// var yearsTest = [2022, 2025];
// var windowDays = 30
// print('30 day window')
// //Execute the function
// yearsTest.forEach(function(year) {
//   printNDYIandMovingAvg(year, windowDays);
// });

// var windowDays = 15
// print('15 day window')
// //Execute the function
// yearsTest.forEach(function(year) {
//   printNDYIandMovingAvg(year, windowDays);
// });

// var windowDays = 5
// print('5 day window')
// //Execute the function
// yearsTest.forEach(function(year) {
//   printNDYIandMovingAvg(year, windowDays);
// });







//-------||-------||-------||-------||PART *       ||-------||-------||-------||-------||
//-------||-------||-------||-------||Visualization||-------||-------||-------||-------||



Map.setCenter(35.0274937578483, 47.35804176552162);

Map.addLayer(outline,{palette: ['blue']}, 'ROI');