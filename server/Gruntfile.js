const path = require('path');


module.exports = function (grunt) {

  // Project configuration.
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),

    babel: {
      nonIe11: {
        options: {
          sourceMap: false,
          configFile: './babel-non-ie11.config.json'
        },
        files: [{
          expand: true,
          cwd: './js-css-src',
          src: ['*.js'],
          dest: './tmp/',
          ext: '.babel.js',
          extDot: 'first'
        }]
      },

      ie11: {
        options: {
          sourceMap: false,
          configFile: './babel-ie11.config.json'
        },
        files: [{
          expand: true,
          cwd: './js-css-src',
          src: ['*.js'],
          dest: './tmp/',
          ext: '-ie11.babel.js',
          extDot: 'first'
        }]
      }
    },

    browserify: {
      options: {
      },
      dist: {
        files: [{          
          expand: true,
          cwd: './tmp',
          src: ['*.babel.js'],
          dest: './tmp',
          ext: '.browserify.js',
          extDot: 'first'
        }]
      }
    },

    uglify: {
      options: {
        ASCIIOnly: true
      },
      dist: {
        files: [{
          expand: true,
          cwd: './tmp',
          src: ['*.browserify.js'],
          dest: './dist/public/',
          ext: '.min.js',
          extDot: 'first'
        }]
      }
    },

    sass: {
      options: {
        style: 'compressed'
      },
      dist: {
        files: [{
          expand: true,
          cwd: './js-css-src',
          src: ['*.scss'],
          dest: './tmp',
          ext: '.compiled.css',
          extDot: 'first'
        }]
      }
    },

    cssmin: {
      options: {
        compatibility: 'ie8',
        keepSpecialComments: '*',
        noAdvanced: true
      },
      common: {
        src: ['./tmp/common.compiled.css'],
        dest: './dist/public/common.min.css'
      },
      excel: {
        src: ['./tmp/{common,excel}.compiled.css'],
        dest: './dist/public/common-excel.min.css'
      }
    },

    watch: {
      jsBrowser: {
        files: ['./js-css-src/*.js'],
        tasks: ['babel:nonIe11', 'browserify', 'uglify']
      },
      jsExcel: {
        files: ['./js-css-src/*.js'],
        tasks: ['babel:ie11', 'browserify', 'uglify']
      },
      sass: {
        files: ['./js-css-src/*.{scss,css}'],
        tasks: ['sass', 'cssmin']
      }
    }
  });

  grunt.loadNpmTasks('grunt-babel');
  grunt.loadNpmTasks('grunt-browserify');
  grunt.loadNpmTasks('grunt-contrib-uglify');
  grunt.loadNpmTasks('grunt-contrib-sass');
  grunt.loadNpmTasks('grunt-contrib-cssmin');
  grunt.loadNpmTasks('grunt-contrib-watch');
  
  grunt.registerTask('js', ['babel', 'browserify', 'uglify']);
  grunt.registerTask('css', ['sass', 'cssmin']);
  grunt.registerTask('default', ['js', 'css']);

};