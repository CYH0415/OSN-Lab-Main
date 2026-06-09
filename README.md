# Black-Box Reverse Modeling and Prediction of Google Play Age Rating Questionnaire

## Experiment Description

Google Play uses an age rating mechanism to help parents identify applications
that are suitable for minors. In the Google Play Store, each app can display an
age rating, content descriptors, and interactive elements. These results are
generated after developers complete the Google Play content rating
questionnaire.

The rating process is opaque to developers and users because Google does not
publish the exact decision rules behind the questionnaire. This experiment
treats the questionnaire-based rating system as a black box and uses a
data-driven method to reverse model the relationship between questionnaire
answers and final age rating results.

The goal is to collect diverse questionnaire-answer samples, train predictive
models, and evaluate whether the final Google Play age rating can be accurately
predicted from questionnaire responses.

Google Play Developer Console:
https://play.google.com/console/developers

Access requires a registered Google Play Developer account.

## Objectives

- Design a systematic strategy for sampling a tree-structured content rating
  questionnaire.
- Automate questionnaire submission and rating-result collection through
  scripts.
- Collect at least 1,000 valid and diverse samples.
- Perform feature engineering on the collected questionnaire data.
- Train machine learning models for multi-class age rating prediction.
- Compare at least three different models and optimize their performance.
- Analyze model results, category-level differences, and possible patterns in
  Google Play's rating mechanism.

## Experiment Workflow

1. Understand the questionnaire structure
   - Inspect the Google Play content rating questionnaire.
   - Identify question dependencies, branching logic, answer types, and final
     rating output fields.
   - Treat the questionnaire and rating result as an input-output black-box
     system.

2. Design the data collection strategy
   - Build a sampling strategy for the tree-structured questionnaire.
   - Ensure that generated answer combinations cover different questionnaire
     branches and content-risk patterns.
   - Avoid collecting duplicate or low-value samples.

3. Implement automated data collection
   - Write scripts to submit questionnaire answers automatically through the
     Google Play Developer Console.
   - Record the submitted answers and returned age rating results.
   - Validate each collected sample and retain at least 1,000 valid samples.

4. Build the dataset
   - Clean the raw submission records.
   - Encode questionnaire answers as model features.
   - Label each sample with the final age rating result.
   - Analyze the dataset distribution across rating categories.

5. Train prediction models
   - Train models for multi-class age rating prediction.
   - Test at least three different model types.
   - Compare model performance using suitable classification metrics.
   - Tune model parameters and feature representations where needed.

6. Analyze experimental results
   - Evaluate overall model performance.
   - Compare prediction quality across different age rating categories.
   - Identify influential questionnaire items or answer patterns.
   - Summarize what the results suggest about the hidden rating mechanism.

7. Write the final report
   - Describe the data collection strategy and dataset characteristics.
   - Explain model training, evaluation, and optimization.
   - Document problems encountered and corresponding solutions.
   - Present result analysis, major findings, core code, and key charts.

## Expected Deliverables

- Automated data collection scripts.
- A dataset containing at least 1,000 valid questionnaire samples.
- Feature engineering and model training code.
- Performance comparison for at least three prediction models.
- Result charts and analysis of influential questionnaire factors.
- A complete experiment report.
